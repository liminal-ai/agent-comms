// The MCP endpoint is an OAuth resource server; AuthKit (WorkOS) is the
// authorization server. A request needs an AuthKit access token minted for
// this server (issuer and audience checked), and its subject must be allowed:
// listed in allowedSubjects, or a WorkOS user whose verified email is in
// allowedEmails. AuthKit access tokens don't carry the email, so it's looked
// up in the WorkOS API and cached. Tokens and the API key are never logged.

import { readFile } from "node:fs/promises";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";

export interface User {
  email: string;
  emailVerified: boolean;
}

/** Resolves a token subject to its WorkOS user; null if there is no such user. Throws when it can't tell. */
export type UserLookup = (sub: string) => Promise<User | null>;

export function workosUserLookup(apiKeyFile: string, request: typeof fetch = fetch): UserLookup {
  return async (sub) => {
    const key = (await readFile(apiKeyFile, "utf8")).trim();
    if (!key) throw new Error("WorkOS API key file is empty");
    const res = await request(`https://api.workos.com/user_management/users/${encodeURIComponent(sub)}`, {
      headers: { authorization: `Bearer ${key}`, accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 404) {
      await res.text().catch(() => "");
      return null;
    }
    if (!res.ok) {
      await res.text().catch(() => "");
      throw new Error(`WorkOS user lookup answered HTTP ${res.status}`);
    }
    const user = (await res.json()) as { email?: unknown; email_verified?: unknown };
    return typeof user.email === "string" ? { email: user.email, emailVerified: user.email_verified === true } : null;
  };
}

export interface AuthOptions {
  issuer: string;
  /** The canonical resource URL; tokens must carry it as their audience. */
  resource: string;
  /** Where clients learn how to get a token; named in every 401. */
  resourceMetadataUrl: string;
  jwksUrl: string;
  allowedEmails: string[];
  allowedSubjects: string[];
  lookup?: UserLookup;
  /** For tests: a key source instead of fetching jwksUrl. */
  keys?: JWTVerifyGetKey;
  now?: () => number;
}

export type AuthResult =
  | { ok: true; principal: string }
  | { ok: false; status: 401 | 403 | 503; wwwAuthenticate?: string; message: string };

export type Access = "allowed" | "denied" | "unknown";

const ALLOWED_FOR_MS = 12 * 3_600_000;
const DENIED_FOR_MS = 60_000;

export class Authenticator {
  private readonly keys: JWTVerifyGetKey;
  private readonly emails: Set<string>;
  private readonly cache = new Map<string, { allowed: boolean; until: number }>();
  private readonly now: () => number;
  private readonly o: AuthOptions;

  constructor(o: AuthOptions) {
    this.o = o;
    this.keys = o.keys ?? createRemoteJWKSet(new URL(o.jwksUrl));
    this.emails = new Set(o.allowedEmails.map((e) => e.toLowerCase()));
    this.now = o.now ?? Date.now;
  }

  private challenge(error: string, description: string): string {
    return `Bearer error="${error}", error_description="${description}", resource_metadata="${this.o.resourceMetadataUrl}"`;
  }

  /** Check an `Authorization` header. */
  async authenticate(header: string | undefined): Promise<AuthResult> {
    const token = /^Bearer ([A-Za-z0-9._~+/=-]+)$/i.exec(header ?? "")?.[1];
    if (!token) {
      return { ok: false, status: 401, wwwAuthenticate: this.challenge("unauthorized", "Authorization needed"), message: "no bearer token" };
    }
    let sub: string;
    try {
      const { payload } = await jwtVerify(token, this.keys, {
        issuer: this.o.issuer,
        audience: this.o.resource,
        algorithms: ["RS256"],
        requiredClaims: ["exp", "sub"],
        currentDate: new Date(this.now()),
      });
      if (typeof payload.sub !== "string" || !payload.sub) throw new Error("token has no subject");
      sub = payload.sub;
    } catch {
      return { ok: false, status: 401, wwwAuthenticate: this.challenge("invalid_token", "The access token is invalid or expired"), message: "invalid token" };
    }
    const access = await this.authorize(sub);
    if (access === "allowed") return { ok: true, principal: sub };
    if (access === "denied") return { ok: false, status: 403, message: "this account isn't allowed to use this server" };
    return { ok: false, status: 503, message: "couldn't check this account's access; try again shortly" };
  }

  /** Is this subject allowed? `unknown` when the user lookup failed. Used again at delivery to catch revoked access. */
  async authorize(sub: string): Promise<Access> {
    if (this.o.allowedSubjects.includes(sub)) return "allowed";
    if (!this.emails.size || !this.o.lookup) return "denied";
    const hit = this.cache.get(sub);
    if (hit && hit.until > this.now()) return hit.allowed ? "allowed" : "denied";
    let user: User | null;
    try {
      user = await this.o.lookup(sub);
    } catch {
      return "unknown";
    }
    const allowed = !!user && user.emailVerified && this.emails.has(user.email.toLowerCase());
    // Expired entries go before a new one is added, so the cache holds only live decisions.
    const now = this.now();
    for (const [key, entry] of this.cache) if (entry.until <= now) this.cache.delete(key);
    this.cache.set(sub, { allowed, until: now + (allowed ? ALLOWED_FOR_MS : DENIED_FOR_MS) });
    return allowed ? "allowed" : "denied";
  }
}
