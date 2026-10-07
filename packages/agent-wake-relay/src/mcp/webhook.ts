// The outbound half of MCP Events webhook delivery: Standard Webhooks signing
// and a POST that only reaches public addresses. The callback URL and secret
// come from the subscriber (ChatGPT), so neither is logged.
//
// What the address guard enforces: https only; every address the hostname
// resolves to must be public unicast (no loopback, private, CGNAT/Tailscale,
// link-local, multicast, documentation or reserved ranges, v4 or v6), checked
// when the connection is made and connected to as checked, so DNS rebinding
// can't swap in a private address after the check; redirects aren't followed.

import { createHmac, randomBytes } from "node:crypto";
import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";

/** Standard Webhooks caps the key at 64 bytes and asks for at least 24. */
export function parseSecret(secret: unknown): Buffer | null {
  if (typeof secret !== "string" || !secret.startsWith("whsec_")) return null;
  const b64 = secret.slice("whsec_".length);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64) || b64.length % 4 !== 0) return null;
  const key = Buffer.from(b64, "base64");
  return key.length >= 24 && key.length <= 64 ? key : null;
}

/** `webhook-signature` for one body: `v1,<base64 HMAC-SHA256(key, id.timestamp.body)>`, one per key, space-separated. */
export function sign(keys: Buffer[], id: string, timestamp: number, body: string): string {
  return keys.map((k) => `v1,${createHmac("sha256", k).update(`${id}.${timestamp}.${body}`).digest("base64")}`).join(" ");
}

export function randomId(prefix: string): string {
  return `${prefix}_${randomBytes(16).toString("hex")}`;
}

const blocked = new BlockList();
for (const [net, bits] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15],
  ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) blocked.addSubnet(net, bits, "ipv4");
const globalV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");
// Inside 2000::/3: IETF protocol assignments (Teredo etc.), documentation, 6to4.
for (const [net, bits] of [["2001::", 23], ["2001:db8::", 32], ["2002::", 16]] as const) blocked.addSubnet(net, bits, "ipv6");

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !blocked.check(address, "ipv4");
  if (family !== 6) return false;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped) return isPublicAddress(mapped[1]!);
  return globalV6.check(address, "ipv6") && !blocked.check(address, "ipv6");
}

/** Which callback URLs may be reached. Production is the default; tests loosen it to reach a loopback server. */
export interface UrlPolicy {
  allowHttp?: boolean;
  allowPrivate?: boolean;
}

export class BlockedUrlError extends Error {}

/** Checks the URL's shape. Returns a reason it's unacceptable, or null. */
export function urlProblem(url: string, policy: UrlPolicy = {}): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return "not a URL";
  }
  if (u.protocol !== "https:" && !(policy.allowHttp && u.protocol === "http:")) return "must be https";
  if (u.username || u.password) return "must not carry credentials";
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host) && !policy.allowPrivate && !isPublicAddress(host)) return "is not a public address";
  return null;
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

/** A dns.lookup that refuses non-public results; the socket connects to exactly what it returns. */
function guardedLookup(policy: UrlPolicy) {
  return (hostname: string, options: { all?: boolean }, callback: LookupCallback) => {
    dnsLookup(hostname, { all: true }, (err, addresses) => {
      if (err) return callback(err, []);
      if (!addresses.length) return callback(new BlockedUrlError("no address") as NodeJS.ErrnoException, []);
      if (!policy.allowPrivate && addresses.some((a) => !isPublicAddress(a.address))) {
        const e = new BlockedUrlError("callback host resolves to a non-public address") as NodeJS.ErrnoException;
        e.code = "EBLOCKED";
        return callback(e, []);
      }
      if (options.all) return callback(null, addresses);
      callback(null, addresses[0]!.address, addresses[0]!.family);
    });
  };
}

export interface PostResult {
  status: number;
  body: string;
}

/** What went wrong with a delivery, in the MCP Events `lastError` categories. Never a raw response. */
export type FailureReason = "connection_refused" | "timeout" | "tls_error" | "http_4xx" | "http_5xx" | "challenge_failed";

export class DeliveryError extends Error {
  readonly reason: FailureReason;
  constructor(reason: FailureReason) {
    super(reason);
    this.reason = reason;
  }
}

export type Post = (url: string, headers: Record<string, string>, body: string, timeoutMs: number) => Promise<PostResult>;

/** POST through the address guard. Doesn't follow redirects; reads at most 64 KiB of the answer. */
export function guardedPost(policy: UrlPolicy = {}): Post {
  return (url, headers, body, timeoutMs) =>
    new Promise((resolve, reject) => {
      const problem = urlProblem(url, policy);
      if (problem) return reject(new BlockedUrlError(`callback URL ${problem}`));
      const u = new URL(url);
      const send = u.protocol === "https:" ? httpsRequest : httpRequest;
      const req = send(
        u,
        {
          method: "POST",
          headers: { ...headers, "content-length": String(Buffer.byteLength(body)) },
          lookup: guardedLookup(policy) as never,
          timeout: timeoutMs,
        },
        (res) => {
          const chunks: Buffer[] = [];
          let size = 0;
          res.on("data", (c: Buffer) => {
            size += c.length;
            if (size <= 65_536) chunks.push(c);
            else res.destroy();
          });
          const done = () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") });
          res.on("end", done);
          res.on("close", done);
        },
      );
      const timer = setTimeout(() => req.destroy(new DeliveryError("timeout")), timeoutMs);
      req.on("timeout", () => req.destroy(new DeliveryError("timeout")));
      req.on("error", (e) => reject(e));
      req.on("close", () => clearTimeout(timer));
      req.end(body);
    });
}

/** Map a transport failure to its category. */
export function failureReason(error: unknown): FailureReason {
  if (error instanceof DeliveryError) return error.reason;
  const code = (error as NodeJS.ErrnoException)?.code ?? "";
  if (code === "ETIMEDOUT") return "timeout";
  if (/^(ERR_TLS|CERT_|UNABLE_TO|DEPTH_ZERO|SELF_SIGNED|ERR_SSL)/.test(code)) return "tls_error";
  return "connection_refused";
}
