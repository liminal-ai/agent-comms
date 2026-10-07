import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey, type JWK } from "jose";
import { parseConfig } from "../src/config.ts";
import { Authenticator, type UserLookup } from "../src/mcp/auth.ts";
import { EventHub, RpcError } from "../src/mcp/events.ts";
import { createMcpServer, PROTOCOL_VERSION } from "../src/mcp/server.ts";
import { canonicalJson, SubscriptionStore } from "../src/mcp/store.ts";
import { BlockedUrlError, guardedPost, isPublicAddress, parseSecret, sign, urlProblem } from "../src/mcp/webhook.ts";

const loopback = { allowHttp: true, allowPrivate: true };
const newSecret = () => `whsec_${randomBytes(32).toString("base64")}`;

async function listen(server: Server): Promise<number> {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return (server.address() as { port: number }).port;
}

interface Received {
  headers: IncomingHttpHeaders;
  body: string;
}

/** A stand-in for ChatGPT's callback: records what arrives and answers through `respond`. */
async function receiver(respond: (r: Received) => { status: number; body?: string }) {
  const seen: Received[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const r = { headers: req.headers, body };
      seen.push(r);
      const out = respond(r);
      res.writeHead(out.status, { "content-type": "application/json" }).end(out.body ?? "{}");
    });
  });
  const port = await listen(server);
  return { url: `http://127.0.0.1:${port}/hook/abc`, seen, close: () => server.close() };
}

/** Answers verification by echoing the challenge, events with `eventStatus()`. */
function chatgpt(eventStatus: () => number = () => 200) {
  return (r: Received) => {
    const body = JSON.parse(r.body);
    if (body.type === "verification") return { status: 200, body: JSON.stringify({ challenge: body.challenge }) };
    return { status: eventStatus() };
  };
}

/** Verifies a delivery the way a Standard Webhooks receiver would. */
function verifies(r: Received, secret: string): boolean {
  const key = parseSecret(secret)!;
  const expected = createHmac("sha256", key).update(`${r.headers["webhook-id"]}.${r.headers["webhook-timestamp"]}.${r.body}`).digest("base64");
  return String(r.headers["webhook-signature"]).split(" ").includes(`v1,${expected}`);
}

async function hub(opts: { authorize?: (p: string) => Promise<"allowed" | "denied" | "unknown">; now?: () => number } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "wake-mcp-"));
  const now = opts.now ?? Date.now;
  const store = new SubscriptionStore(join(dir, "state.json"), now);
  const logs: string[] = [];
  const h = new EventHub({
    targets: [{ participant: "dot", event: "comms.delivery.dot" }],
    store,
    post: guardedPost(loopback),
    urlPolicy: loopback,
    log: (l) => logs.push(l),
    sleep: async () => {},
    now,
    ...(opts.authorize ? { authorize: opts.authorize } : {}),
  });
  return { h, store, dir, logs };
}

const sub = (url: string, secret: string, extra: Record<string, unknown> = {}) => ({
  name: "comms.delivery.dot",
  arguments: {},
  delivery: { mode: "webhook", url, secret },
  cursor: null,
  ...extra,
});

describe("webhook signing", () => {
  it("matches the Standard Webhooks reference vector", () => {
    const key = parseSecret("whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw")!;
    assert.equal(sign([key], "msg_p5jXN8AQM9LWM0D4loKWxJek", 1614265330, '{"test": 2432232314}'), "v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=");
  });

  it("space-separates one signature per key during a rotation", () => {
    const a = parseSecret(newSecret())!;
    const b = parseSecret(newSecret())!;
    const both = sign([a, b], "id", 1, "{}").split(" ");
    assert.deepEqual(both, [sign([a], "id", 1, "{}"), sign([b], "id", 1, "{}")]);
  });

  it("accepts only whsec_ secrets of 24-64 bytes", () => {
    assert.ok(parseSecret(`whsec_${randomBytes(24).toString("base64")}`));
    assert.ok(parseSecret(`whsec_${randomBytes(64).toString("base64")}`));
    assert.equal(parseSecret(`whsec_${randomBytes(16).toString("base64")}`), null);
    assert.equal(parseSecret(`whsec_${randomBytes(65).toString("base64")}`), null);
    assert.equal(parseSecret(randomBytes(32).toString("base64")), null);
    assert.equal(parseSecret("whsec_not base64!"), null);
  });
});

describe("callback address guard", () => {
  it("knows public from private addresses", () => {
    for (const a of ["8.8.8.8", "104.18.32.47", "2606:4700::6810:84e5"]) assert.ok(isPublicAddress(a), a);
    for (const a of ["127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.1.1", "100.126.86.93", "169.254.169.254", "0.0.0.0", "224.0.0.1", "::1", "fe80::1", "fd7a:115c:a1e0::1", "::ffff:127.0.0.1", "2001:db8::1", "::"]) {
      assert.ok(!isPublicAddress(a), a);
    }
  });

  it("refuses http, credentials and private literals by default", () => {
    assert.match(urlProblem("http://example.com/x")!, /https/);
    assert.match(urlProblem("https://u:p@example.com/x")!, /credentials/);
    assert.match(urlProblem("https://127.0.0.1/x")!, /public/);
    assert.match(urlProblem("https://[::1]/x")!, /public/);
    assert.equal(urlProblem("https://chatgpt.com/hook"), null);
  });

  it("refuses a hostname that resolves to a private address, at connection time", async () => {
    const r = await receiver(() => ({ status: 200 }));
    try {
      const port = new URL(r.url).port;
      await assert.rejects(guardedPost({ allowHttp: true })(`http://localhost:${port}/x`, {}, "{}", 2_000), BlockedUrlError);
      assert.equal(r.seen.length, 0);
    } finally {
      r.close();
    }
  });

  it("doesn't follow redirects", async () => {
    const r = await receiver(() => ({ status: 302 }));
    try {
      const res = await guardedPost(loopback)(r.url, {}, "{}", 2_000);
      assert.equal(res.status, 302);
      assert.equal(r.seen.length, 1);
    } finally {
      r.close();
    }
  });
});

describe("subscriptions", () => {
  it("verifies the callback with a signed challenge before subscribing", async () => {
    const r = await receiver(chatgpt());
    const { h, store } = await hub();
    try {
      const secret = newSecret();
      const res = await h.subscribe("user_1", sub(r.url, secret, { ttlMs: 3_600_000 }));
      assert.match(res.id, /^sub_[0-9a-f]{32}$/);
      assert.equal(res.cursor, null);
      assert.equal(res.truncated, false);
      assert.ok(Math.abs(Date.parse(res.refreshBefore) - (Date.now() + 3_600_000)) < 5_000);
      assert.equal(r.seen.length, 1);
      const v = r.seen[0]!;
      assert.equal(JSON.parse(v.body).type, "verification");
      assert.match(String(v.headers["webhook-id"]), /^msg_verification_/);
      assert.equal(v.headers["x-mcp-subscription-id"], res.id);
      assert.equal(v.headers["content-type"], "application/json");
      assert.ok(verifies(v, secret));
      assert.equal(store.active().length, 1);
    } finally {
      r.close();
    }
  });

  it("refuses a callback that doesn't echo the challenge or doesn't answer 2xx", async () => {
    for (const [respond, reason] of [
      [() => ({ status: 200, body: JSON.stringify({ challenge: "wrong" }) }), "challenge_failed"],
      [() => ({ status: 200, body: "not json" }), "challenge_failed"],
      [() => ({ status: 500 }), "http_5xx"],
      [() => ({ status: 404 }), "http_4xx"],
    ] as const) {
      const r = await receiver(respond);
      const { h, store } = await hub();
      try {
        await assert.rejects(h.subscribe("user_1", sub(r.url, newSecret())), (e: RpcError) => e.code === -32015 && (e.data as { reason: string }).reason === reason);
        assert.equal(store.active().length, 0);
      } finally {
        r.close();
      }
    }
  });

  it("validates the event, arguments, delivery and secret", async () => {
    const { h } = await hub();
    const url = "http://127.0.0.1:9/hook";
    await assert.rejects(h.subscribe("u", { ...sub(url, newSecret()), name: "nope" }), (e: RpcError) => e.code === -32011);
    await assert.rejects(h.subscribe("u", sub(url, newSecret(), { arguments: { participant: "dot" } })), (e: RpcError) => e.code === -32602);
    await assert.rejects(h.subscribe("u", sub(url, "whsec_c2hvcnQ=")), (e: RpcError) => e.code === -32602);
    await assert.rejects(h.subscribe("u", { ...sub(url, newSecret()), delivery: { mode: "push", url, secret: newSecret() } }), (e: RpcError) => e.code === -32014);
    await assert.rejects(h.subscribe("u", sub(url, newSecret(), { ttlMs: "soon" })), (e: RpcError) => e.code === -32602);
    const strict = new EventHub({ targets: [{ participant: "dot", event: "comms.delivery.dot" }], store: new SubscriptionStore("/nonexistent"), post: guardedPost(), log: () => {} });
    await assert.rejects(strict.subscribe("u", sub("http://example.com/hook", newSecret())), (e: RpcError) => e.code === -32602 && /https/.test(e.message));
  });

  it("refreshes idempotently (same id, no second challenge), rotates the secret, and clamps the TTL", async () => {
    const r = await receiver(chatgpt());
    const { h, store } = await hub();
    try {
      const first = await h.subscribe("user_1", sub(r.url, newSecret(), { ttlMs: 1_000 }));
      assert.ok(Date.parse(first.refreshBefore) - Date.now() >= 59_000, "clamped up to a minute");
      const rotated = newSecret();
      const again = await h.subscribe("user_1", sub(r.url, rotated, { ttlMs: null, arguments: undefined }));
      assert.equal(again.id, first.id);
      assert.ok(Date.parse(again.refreshBefore) - Date.now() > 29 * 86_400_000, "no-expiry asks get the maximum");
      assert.equal(r.seen.length, 1, "verification is cached per principal and URL");
      assert.equal(store.active().length, 1);
      const s = store.get(first.id)!;
      assert.equal(s.secret, rotated);
      assert.ok(s.previousSecret);
      const other = await h.subscribe("user_2", sub(r.url, newSecret()));
      assert.notEqual(other.id, first.id, "another principal is another subscription");
      assert.equal(r.seen.length, 2, "and is verified on its own");
    } finally {
      r.close();
    }
  });

  it("unsubscribes only the caller's own subscription, idempotently", async () => {
    const r = await receiver(chatgpt());
    const { h, store } = await hub();
    try {
      await h.subscribe("user_1", sub(r.url, newSecret()));
      const params = { name: "comms.delivery.dot", arguments: {}, delivery: { mode: "webhook", url: r.url } };
      await h.unsubscribe("user_2", params);
      assert.equal(store.active().length, 1);
      await h.unsubscribe("user_1", params);
      assert.equal(store.active().length, 0);
      await h.unsubscribe("user_1", params);
    } finally {
      r.close();
    }
  });

  it("persists across a restart, mode 600, dropping what has expired", async () => {
    const r = await receiver(chatgpt());
    let now = Date.now();
    const { h, dir } = await hub({ now: () => now });
    try {
      const a = await h.subscribe("user_1", sub(r.url, newSecret(), { ttlMs: 3_600_000 }));
      await h.subscribe("user_2", sub(r.url, newSecret(), { ttlMs: 60_000 }));
      const path = join(dir, "state.json");
      // POSIX modes only; Windows has none to check.
      if (process.platform !== "win32") assert.equal((await stat(path)).mode & 0o777, 0o600);
      now += 120_000;
      const reloaded = new SubscriptionStore(path, () => now);
      await reloaded.load();
      assert.deepEqual(reloaded.active().map((s) => s.id), [a.id]);
      assert.equal(JSON.parse(await readFile(path, "utf8")).subscriptions.length, 1, "the expired one is gone from the file too");
    } finally {
      r.close();
    }
  });

  it("compares arguments as canonical JSON", () => {
    assert.equal(canonicalJson({ b: 1, a: { d: [1, { y: 2, x: 1 }], c: null } }), canonicalJson({ a: { c: null, d: [1, { x: 1, y: 2 }] }, b: 1 }));
  });
});

describe("event delivery", () => {
  it("POSTs a signed event to every subscription and holds the eventId across retries", async () => {
    const statuses = [503, 200];
    const r = await receiver(chatgpt(() => statuses.shift() ?? 200));
    const { h } = await hub();
    try {
      const secret = newSecret();
      const { id } = await h.subscribe("user_1", sub(r.url, secret));
      await h.waker("dot")(["d1", "d2"]);
      const events = r.seen.slice(1);
      assert.equal(events.length, 2, "one retry after the 503");
      const [a, b] = events.map((e) => ({ e, body: JSON.parse(e.body) }));
      assert.equal(a!.body.eventId, b!.body.eventId);
      assert.equal(a!.e.headers["webhook-id"], a!.body.eventId);
      assert.match(a!.body.eventId, /^evt_/);
      assert.equal(a!.body.name, "comms.delivery.dot");
      assert.equal(a!.body.cursor, null);
      assert.ok(!Number.isNaN(Date.parse(a!.body.timestamp)));
      assert.deepEqual(a!.body.data, { participant: "dot", deliveryIds: ["d1", "d2"], count: 2, summary: "2 comms deliveries are waiting for @dot." });
      assert.equal(a!.e.headers["x-mcp-subscription-id"], id);
      assert.match(String(a!.e.headers["webhook-timestamp"]), /^\d+$/);
      for (const { e } of [a!, b!]) assert.ok(verifies(e, secret));
    } finally {
      r.close();
    }
  });

  it("doesn't retry a 410 or 413, and fails the wake terminally when nobody accepted", async () => {
    for (const status of [410, 413]) {
      const r = await receiver(chatgpt(() => status));
      const { h, store } = await hub();
      try {
        await h.subscribe("user_1", sub(r.url, newSecret()));
        await assert.rejects(h.waker("dot")(["d1"]), (e: Error & { terminal?: boolean }) => e.terminal === true && new RegExp(`HTTP ${status}`).test(e.message));
        assert.equal(r.seen.length, 2, "verification, then one attempt");
        assert.ok(store.active()[0]!.failedSince, "the failure is remembered");
      } finally {
        r.close();
      }
    }
  });

  it("a wake the coordinator retries carries the same event id until a subscriber accepts it", async () => {
    let status = 500;
    const r = await receiver(chatgpt(() => status));
    const { h } = await hub();
    try {
      await h.subscribe("user_1", sub(r.url, newSecret()));
      const wake = h.waker("dot");
      await assert.rejects(wake(["d1", "d2"]), /HTTP 500/);
      await assert.rejects(wake(["d2", "d1"]), /HTTP 500/);
      status = 200;
      await wake(["d1", "d2"]);
      const ids = r.seen.slice(1).map((e) => JSON.parse(e.body).eventId as string);
      assert.ok(ids.length >= 7, "3 attempts, 3 attempts, 1 success");
      assert.equal(new Set(ids).size, 1, "one event id across every attempt of every retry");
      await wake(["d1", "d2"]);
      const next = JSON.parse(r.seen.at(-1)!.body).eventId;
      assert.notEqual(next, ids[0], "accepted: the next wake for the same set is a new event");
    } finally {
      r.close();
    }
  });

  it("a retry resends the pending event unchanged and puts a newcomer in a new event, whichever way it sorts", async () => {
    for (const newcomer of ["0-before", "z-after"]) {
      let status = 500;
      const r = await receiver(chatgpt(() => status));
      const { h } = await hub();
      try {
        await h.subscribe("user_1", sub(r.url, newSecret()));
        const wake = h.waker("dot");
        await assert.rejects(wake(["m"]), /HTTP 500/);
        status = 200;
        await wake([newcomer, "m"]);
        const events = r.seen.slice(1).map((e) => JSON.parse(e.body));
        const first = events[0]!.eventId;
        const retried = events.filter((e) => e.eventId === first);
        assert.ok(retried.length >= 4, "the first event was retried under its own id");
        for (const e of retried) assert.deepEqual(e.data.deliveryIds, ["m"], "its body never changes");
        const fresh = events.filter((e) => e.eventId !== first);
        assert.equal(fresh.length, 1, `${newcomer}: one new event for the newcomer`);
        assert.deepEqual(fresh[0]!.data.deliveryIds, [newcomer]);
        await wake([newcomer, "m"]);
        assert.ok(!events.some((e) => e.eventId === JSON.parse(r.seen.at(-1)!.body).eventId), "all accepted: the next wake starts over with new ids");
      } finally {
        r.close();
      }
    }
  });

  it("a wake with one event accepted and one refused for good is terminal, and nothing is resent", async () => {
    let n = 0;
    const r = await receiver(chatgpt(() => (++n === 1 ? 200 : 410)));
    const { h } = await hub();
    try {
      await h.subscribe("user_1", sub(r.url, newSecret()));
      const ids = Array.from({ length: 6_000 }, (_, i) => `j97${String(i).padStart(5, "0")}${"x".repeat(40)}`);
      const wake = h.waker("dot");
      await assert.rejects(wake(ids), (e: Error & { terminal?: boolean }) => e.terminal === true && /refused for good/.test(e.message));
      const sent = r.seen.length;
      await assert.rejects(wake(ids), /refused for good/); // a later (renudge) wake starts over with fresh ids; the receiver still says 410
      assert.ok(r.seen.length > sent);
      const before = new Set(r.seen.slice(1, sent).map((e) => JSON.parse(e.body).eventId));
      for (const e of r.seen.slice(sent)) assert.ok(!before.has(JSON.parse(e.body).eventId), "fresh ids after a settled wake");
    } finally {
      r.close();
    }
  });

  it("the subscription limit holds under concurrent subscribes", async () => {
    const r = await receiver(chatgpt());
    const { h, store } = await hub();
    try {
      const results = await Promise.allSettled(Array.from({ length: 25 }, (_, i) => h.subscribe("user_1", sub(`${r.url}?n=${i}`, newSecret()))));
      assert.equal(results.filter((x) => x.status === "fulfilled").length, 20);
      assert.equal(store.active().filter((s) => s.principal === "user_1").length, 20);
      for (const x of results) if (x.status === "rejected") assert.equal((x.reason as RpcError).code, -32013);
    } finally {
      r.close();
    }
  });

  it("a retry of a split wake resends only the batches that didn't settle", async () => {
    let calls = 0;
    // First wake: batch 1 accepted, batch 2 fails transiently (all its attempts). Second wake: everything accepted.
    const r = await receiver(chatgpt(() => (++calls <= 1 ? 200 : calls <= 4 ? 503 : 200)));
    const { h } = await hub();
    try {
      await h.subscribe("user_1", sub(r.url, newSecret()));
      const ids = Array.from({ length: 6_000 }, (_, i) => `j97${String(i).padStart(5, "0")}${"x".repeat(40)}`);
      const wake = h.waker("dot");
      await assert.rejects(wake(ids), /no subscriber accepted/);
      const firstRound = r.seen.length;
      await wake(ids);
      const events = r.seen.slice(1).map((e) => JSON.parse(e.body));
      const idsOfBatch1 = events[0].eventId;
      assert.equal(events.filter((e) => e.eventId === idsOfBatch1).length, 1, "the accepted batch was not sent again");
      assert.equal(r.seen.length - firstRound, 1, "the retry sent exactly the failed batch");
      assert.equal(new Set(events.slice(1).map((e) => e.eventId)).size, 1, "the failed batch kept its event id across the retry");
    } finally {
      r.close();
    }
  });

  it("splits a backlog too large for one event into several, each under 256 KiB", async () => {
    const r = await receiver(chatgpt());
    const { h } = await hub();
    try {
      await h.subscribe("user_1", sub(r.url, newSecret()));
      const ids = Array.from({ length: 6_000 }, (_, i) => `j97${String(i).padStart(5, "0")}${"x".repeat(40)}`); // ~300 KiB of ids
      await h.waker("dot")(ids);
      const events = r.seen.slice(1).map((e) => ({ size: Buffer.byteLength(e.body), body: JSON.parse(e.body) }));
      assert.ok(events.length >= 2, `split into ${events.length} events`);
      for (const e of events) assert.ok(e.size <= 256 * 1024);
      assert.deepEqual(events.flatMap((e) => e.body.data.deliveryIds).sort(), [...ids].sort());
      assert.equal(new Set(events.map((e) => e.body.eventId)).size, events.length, "each batch its own event id");
    } finally {
      r.close();
    }
  });

  it("succeeds when one of several subscriptions accepts", async () => {
    const good = await receiver(chatgpt());
    const bad = await receiver(chatgpt(() => 400));
    const { h } = await hub();
    try {
      await h.subscribe("user_1", sub(good.url, newSecret()));
      await h.subscribe("user_1", sub(bad.url, newSecret()));
      await h.waker("dot")(["d1"]);
      assert.equal(good.seen.length, 2);
      assert.equal(bad.seen.length, 2);
    } finally {
      good.close();
      bad.close();
    }
  });

  it("signs with both keys during a secret rotation", async () => {
    const r = await receiver(chatgpt());
    const { h } = await hub();
    try {
      const old = newSecret();
      const rotated = newSecret();
      await h.subscribe("user_1", sub(r.url, old));
      await h.subscribe("user_1", sub(r.url, rotated));
      await h.waker("dot")(["d1"]);
      const event = r.seen.at(-1)!;
      assert.equal(String(event.headers["webhook-signature"]).split(" ").length, 2);
      assert.ok(verifies(event, old) && verifies(event, rotated));
    } finally {
      r.close();
    }
  });

  it("says there's no subscriber, and drops subscriptions whose subscriber lost access", async () => {
    const r = await receiver(chatgpt());
    let access: "allowed" | "denied" | "unknown" = "allowed";
    const { h, store } = await hub({ authorize: async () => access });
    try {
      await assert.rejects(h.waker("dot")(["d1"]), /no subscriber to comms\.delivery\.dot; connect the plugin in ChatGPT/);
      await h.subscribe("user_1", sub(r.url, newSecret()));
      access = "unknown";
      await h.waker("dot")(["d1"]);
      assert.equal(store.active().length, 1, "an unanswerable access check doesn't drop it");
      access = "denied";
      await assert.rejects(h.waker("dot")(["d2"]), /no subscriber/);
      assert.equal(store.active().length, 0);
    } finally {
      r.close();
    }
  });
});

const ISSUER = "https://auth.example.test";
const BASE = "https://relay.example.test:8443";
const RESOURCE = `${BASE}/mcp`;

describe("authorization", () => {
  let jwksServer: Server;
  let jwksUrl: string;
  let privateKey: CryptoKey;
  let otherKey: CryptoKey;

  before(async () => {
    const pair = await generateKeyPair("RS256");
    privateKey = pair.privateKey;
    otherKey = (await generateKeyPair("RS256")).privateKey;
    const jwk: JWK = { ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "RS256", use: "sig" };
    jwksServer = createServer((_req, res) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ keys: [jwk] })));
    jwksUrl = `http://127.0.0.1:${await listen(jwksServer)}/oauth2/jwks`;
  });
  after(() => jwksServer.close());

  const token = (claims: { sub?: string; iss?: string; aud?: string; exp?: string | number } = {}, key?: CryptoKey) =>
    new SignJWT({})
      .setProtectedHeader({ alg: "RS256", kid: "k1" })
      .setSubject(claims.sub ?? "user_lee")
      .setIssuer(claims.iss ?? ISSUER)
      .setAudience(claims.aud ?? RESOURCE)
      .setIssuedAt()
      .setExpirationTime(claims.exp ?? "5m")
      .sign(key ?? privateKey);

  const authenticator = (over: { allowedEmails?: string[]; allowedSubjects?: string[]; lookup?: UserLookup } = {}) =>
    new Authenticator({
      issuer: ISSUER,
      resource: RESOURCE,
      resourceMetadataUrl: `${BASE}/.well-known/oauth-protected-resource`,
      jwksUrl,
      allowedEmails: over.allowedEmails ?? [],
      allowedSubjects: over.allowedSubjects ?? ["user_lee"],
      ...(over.lookup ? { lookup: over.lookup } : {}),
    });

  it("accepts a token from the issuer, for this resource, from an allowed subject", async () => {
    assert.deepEqual(await authenticator().authenticate(`Bearer ${await token()}`), { ok: true, principal: "user_lee" });
  });

  it("answers 401 with a challenge naming the resource metadata", async () => {
    const a = authenticator();
    for (const header of [undefined, "Basic abc", `Bearer ${await token({ aud: "https://elsewhere/mcp" })}`, `Bearer ${await token({ iss: "https://evil.test" })}`, `Bearer ${await token({ exp: Math.floor(Date.now() / 1000) - 120 })}`, `Bearer ${await token({}, otherKey)}`]) {
      const res = await a.authenticate(header);
      assert.equal(res.ok, false, String(header));
      if (res.ok) continue;
      assert.equal(res.status, 401);
      assert.match(res.wwwAuthenticate!, /^Bearer error="(unauthorized|invalid_token)", error_description="[^"]+", resource_metadata="https:\/\/relay\.example\.test:8443\/\.well-known\/oauth-protected-resource"$/);
    }
  });

  it("allows only listed, verified emails, looked up once", async () => {
    const users: Record<string, { email: string; emailVerified: boolean }> = {
      user_lee: { email: "Liminal.Builder@gmail.com", emailVerified: true },
      user_eve: { email: "eve@example.com", emailVerified: true },
      user_unverified: { email: "liminal.builder@gmail.com", emailVerified: false },
    };
    let lookups = 0;
    const a = authenticator({
      allowedSubjects: [],
      allowedEmails: ["liminal.builder@gmail.com"],
      lookup: async (sub) => {
        lookups++;
        if (sub === "user_down") throw new Error("WorkOS is down");
        return users[sub] ?? null;
      },
    });
    assert.equal((await a.authenticate(`Bearer ${await token()}`)).ok, true);
    assert.equal((await a.authenticate(`Bearer ${await token()}`)).ok, true);
    assert.equal(lookups, 1, "cached");
    for (const sub of ["user_eve", "user_unverified", "user_nobody"]) {
      const res = await a.authenticate(`Bearer ${await token({ sub })}`);
      assert.equal(!res.ok && res.status, 403, sub);
    }
    const down = await a.authenticate(`Bearer ${await token({ sub: "user_down" })}`);
    assert.equal(!down.ok && down.status, 503);
  });

  describe("MCP endpoint", () => {
    let server: Server;
    let base: string;
    let r: Awaited<ReturnType<typeof receiver>>;
    let store: SubscriptionStore;
    let upstreamCalls = 0;

    before(async () => {
      r = await receiver(chatgpt());
      const made = await hub();
      store = made.store;
      server = createMcpServer({
        publicBaseUrl: BASE,
        issuer: ISSUER,
        auth: authenticator(),
        hub: made.h,
        log: () => {},
        request: (async (url: string) => {
          upstreamCalls++;
          return new Response(JSON.stringify({ issuer: ISSUER, fetched: url }), { headers: { "content-type": "application/json" } });
        }) as typeof fetch,
      });
      base = `http://127.0.0.1:${await listen(server)}`;
    });
    after(() => {
      server.close();
      r.close();
    });

    async function rpc(method: string, params: Record<string, unknown> = {}, opts: { headers?: Record<string, string>; meta?: Record<string, unknown> | null; id?: number | null } = {}) {
      const meta = opts.meta === null ? undefined : { "io.modelcontextprotocol/protocolVersion": PROTOCOL_VERSION, "io.modelcontextprotocol/clientCapabilities": {}, ...opts.meta };
      const res = await fetch(`${base}/mcp`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${await token()}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": PROTOCOL_VERSION,
          "mcp-method": method,
          ...opts.headers,
        },
        body: JSON.stringify({ jsonrpc: "2.0", ...(opts.id === null ? {} : { id: opts.id ?? 1 }), method, params: { ...params, ...(meta ? { _meta: meta } : {}) } }),
      });
      const text = await res.text();
      return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null };
    }

    it("publishes protected-resource metadata at both well-known paths", async () => {
      for (const path of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
        const res = await fetch(`${base}${path}`);
        assert.equal(res.status, 200);
        assert.deepEqual(await res.json(), { resource: RESOURCE, authorization_servers: [ISSUER], bearer_methods_supported: ["header"] });
      }
    });

    it("proxies the authorization server's metadata, cached", async () => {
      for (let i = 0; i < 2; i++) {
        const res = await fetch(`${base}/.well-known/oauth-authorization-server`);
        assert.deepEqual(await res.json(), { issuer: ISSUER, fetched: `${ISSUER}/.well-known/oauth-authorization-server` });
      }
      assert.equal(upstreamCalls, 1);
    });

    it("answers an unauthenticated request with 401 and the challenge", async () => {
      const res = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      assert.equal(res.status, 401);
      assert.match(res.headers.get("www-authenticate")!, /resource_metadata="https:\/\/relay\.example\.test:8443\/\.well-known\/oauth-protected-resource"/);
    });

    it("answers server/discover", async () => {
      const res = await rpc("server/discover");
      assert.equal(res.status, 200);
      const result = res.body.result;
      assert.equal(result.resultType, "complete");
      assert.deepEqual(result.supportedVersions, [PROTOCOL_VERSION]);
      assert.deepEqual(result.capabilities, { tools: {}, events: {} });
      assert.equal(result._meta["io.modelcontextprotocol/serverInfo"].name, "agent-wake-relay");
    });

    it("answers a malformed request target with 400 and keeps serving", async () => {
      const { request } = await import("node:http");
      const port = (server!.address() as { port: number }).port;
      const status = await new Promise<number>((resolve, reject) => request({ host: "127.0.0.1", port, path: "//[", method: "GET" }, (res) => resolve(res.statusCode!)).on("error", reject).end());
      assert.equal(status, 400);
      assert.equal((await fetch(`http://127.0.0.1:${port}/.well-known/oauth-protected-resource`)).status, 200, "still serving");
    });

    it("lists the events and the profile tool, and calls it", async () => {
      const events = (await rpc("events/list")).body.result.events;
      assert.equal(events.length, 1);
      assert.equal(events[0].name, "comms.delivery.dot");
      assert.deepEqual(events[0].delivery, ["webhook"]);
      assert.ok(events[0].inputSchema && events[0].payloadSchema);
      const tools = (await rpc("tools/list")).body.result.tools;
      assert.deepEqual(tools.map((t: { name: string }) => t.name), ["get_profile"]);
      const call = await rpc("tools/call", { name: "get_profile", arguments: {} }, { headers: { "mcp-name": "get_profile" } });
      assert.deepEqual(call.body.result.structuredContent, { id: "user_lee" });
      const encoded = await rpc("tools/call", { name: "get_profile", arguments: {} }, { headers: { "mcp-name": `=?base64?${Buffer.from("get_profile").toString("base64")}?=` } });
      assert.equal(encoded.status, 200);
    });

    it("subscribes and unsubscribes over HTTP", async () => {
      const params = { name: "comms.delivery.dot", arguments: {}, delivery: { mode: "webhook", url: r.url, secret: newSecret() }, cursor: null, ttlMs: 86_400_000 };
      const res = await rpc("events/subscribe", params);
      assert.equal(res.status, 200);
      assert.match(res.body.result.id, /^sub_/);
      assert.equal(res.body.result.truncated, false);
      assert.equal(store.active()[0]!.principal, "user_lee");
      const gone = await rpc("events/unsubscribe", { name: "comms.delivery.dot", arguments: {}, delivery: { mode: "webhook", url: r.url } });
      assert.equal(gone.body.result.resultType, "complete");
      assert.equal(store.active().length, 0);
      const bad = await rpc("events/subscribe", { ...params, name: "comms.delivery.nobody" });
      assert.equal(bad.status, 200);
      assert.equal(bad.body.error.code, -32011);
    });

    it("enforces the 2026-07-28 request rules", async () => {
      const mismatch = await rpc("tools/list", {}, { headers: { "mcp-method": "events/list" } });
      assert.deepEqual([mismatch.status, mismatch.body.error.code], [400, -32020]);
      const noVersionHeader = await rpc("tools/list", {}, { headers: { "mcp-protocol-version": "" } });
      assert.deepEqual([noVersionHeader.status, noVersionHeader.body.error.code], [400, -32020]);
      const noName = await rpc("tools/call", { name: "get_profile" });
      assert.deepEqual([noName.status, noName.body.error.code], [400, -32020]);
      const noMeta = await rpc("tools/list", {}, { meta: null });
      assert.deepEqual([noMeta.status, noMeta.body.error.code], [400, -32602]);
      const old = await rpc("tools/list", {}, { headers: { "mcp-protocol-version": "2025-11-25" }, meta: { "io.modelcontextprotocol/protocolVersion": "2025-11-25" } });
      assert.deepEqual([old.status, old.body.error.code, old.body.error.data.supported], [400, -32022, [PROTOCOL_VERSION]]);
      const init = await rpc("initialize", { protocolVersion: "2025-06-18" }, { meta: null });
      assert.deepEqual([init.status, init.body.error.code], [400, -32022]);
      const unknown = await rpc("prompts/list");
      assert.deepEqual([unknown.status, unknown.body.error.code], [404, -32601]);
      const notification = await rpc("notifications/whatever", {}, { id: null });
      assert.equal(notification.status, 202);
      const origin = await rpc("tools/list", {}, { headers: { origin: "https://evil.test" } });
      assert.equal(origin.status, 403);
      const get = await fetch(`${base}/mcp`, { headers: { authorization: `Bearer ${await token()}` } });
      assert.equal(get.status, 405);
    });
  });
});

describe("mcp config", () => {
  it("requires the mcp section for mcp-events targets and validates it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wake-"));
    for (const f of ["secret", "workos.key"]) await writeFile(join(dir, f), "x");
    const target = { participant: "dot", machine: "dot-vm", machineSecretFile: join(dir, "secret"), waker: { kind: "mcp-events" } };
    const mcp = {
      listen: { port: 18790 },
      publicBaseUrl: "https://lim-builder.tailb30114.ts.net:8443/",
      issuer: "https://enthusiastic-roar-48-staging.authkit.app",
      workosApiKeyFile: join(dir, "workos.key"),
      allowedEmails: ["liminal.builder@gmail.com"],
      stateFile: join(dir, "mcp-state.json"),
    };
    const base = { convexUrl: "https://x.convex.cloud", targets: [target] };
    assert.throws(() => parseConfig(base), /mcp: required/);
    const c = parseConfig({ ...base, mcp });
    assert.deepEqual(c.targets[0]!.waker, { kind: "mcp-events", event: "comms.delivery.dot" });
    assert.equal(c.mcp!.host, "127.0.0.1");
    assert.equal(c.mcp!.publicBaseUrl, "https://lim-builder.tailb30114.ts.net:8443");
    assert.equal(c.mcp!.jwksUrl, "https://enthusiastic-roar-48-staging.authkit.app/oauth2/jwks");
    assert.equal(c.mcp!.maxTtlMs, 30 * 86_400_000);
    assert.equal(parseConfig({ ...base, targets: [{ ...target, waker: { kind: "mcp-events", event: "dot.wake" } }], mcp }).targets[0]!.waker.kind, "mcp-events");
    assert.throws(() => parseConfig({ ...base, mcp: { ...mcp, workosApiKeyFile: undefined } }), /workosApiKeyFile/);
    assert.throws(() => parseConfig({ ...base, mcp: { ...mcp, workosApiKeyFile: join(dir, "nope") } }), /doesn't exist/);
    assert.throws(() => parseConfig({ ...base, mcp: { ...mcp, allowedEmails: [] } }), /allowedEmails or allowedSubjects/);
    assert.throws(() => parseConfig({ ...base, mcp: { ...mcp, publicBaseUrl: "http://lim-builder:8443" } }), /https/);
    assert.throws(() => parseConfig({ ...base, mcp: { ...mcp, publicBaseUrl: "https://lim-builder:8443/mcp" } }), /without a path/);
    assert.throws(() => parseConfig({ ...base, mcp: { ...mcp, stateFile: join(dir, "missing", "state.json") } }), /doesn't exist/);
    assert.throws(() => parseConfig({ ...base, mcp: { ...mcp, listen: { port: 0 } } }), /port/);
    assert.throws(() => parseConfig({ ...base, targets: [target, { ...target, participant: "dot2", waker: { kind: "mcp-events", event: "comms.delivery.dot" } }], mcp }), /used twice/);
  });
});

describe("subscription store", () => {
  it("two concurrent puts that both fail to save leave nothing live", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wake-mcp-"));
    const store = new SubscriptionStore(join(dir, "missing-dir", "state.json"));
    const base = { principal: "u", url: "https://example.com/h", event: "comms.delivery.dot", arguments: "{}", createdAt: 0, verifiedAt: 0, expiresAt: Date.now() + 60_000 };
    const a = store.put({ ...base, id: "sub_x", secret: "whsec_a" } as unknown as Parameters<typeof store.put>[0]);
    const b = store.put({ ...base, id: "sub_x", secret: "whsec_b" } as unknown as Parameters<typeof store.put>[0]);
    await assert.rejects(a);
    await assert.rejects(b);
    assert.equal(store.get("sub_x"), undefined, "neither failed subscription may stay live");
  });

  it("a failed save doesn't undo a newer entry installed meanwhile", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wake-mcp-"));
    const store = new SubscriptionStore(join(dir, "state.json"));
    const base = { principal: "u", url: "https://example.com/h", event: "comms.delivery.dot", arguments: "{}", createdAt: 0, verifiedAt: 0, expiresAt: Date.now() + 60_000 };
    const first = { ...base, id: "sub_x", secret: "whsec_first" } as unknown as Parameters<typeof store.put>[0];
    const second = { ...base, id: "sub_x", secret: "whsec_second" } as unknown as Parameters<typeof store.put>[0];
    const realSave = store.save.bind(store);
    let fail = true;
    store.save = () => (fail ? ((fail = false), Promise.reject(new Error("ENOSPC"))) : realSave());
    const a = store.put(first);
    const b = store.put(second);
    await assert.rejects(a);
    await b;
    assert.equal(store.get("sub_x")?.secret, "whsec_second", "the newer refresh survives the older one's rollback");
  });

  it("leaves the live map unchanged when the state file can't be written", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wake-mcp-"));
    const store = new SubscriptionStore(join(dir, "missing-dir", "state.json"));
    const sub = { id: "sub_x", principal: "u", url: "https://example.com/h", event: "comms.delivery.dot", arguments: "{}", secret: "whsec_x", createdAt: 0, verifiedAt: 0, expiresAt: Date.now() + 60_000 } as unknown as Parameters<typeof store.put>[0];
    await assert.rejects(store.put(sub));
    assert.equal(store.get("sub_x"), undefined, "a subscription that was never persisted must not be live");
    assert.equal(store.active().length, 0);
  });
});
