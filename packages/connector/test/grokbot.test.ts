// Grok Bot's bridge against the real connector and Convex functions (both
// backends): an answer the connector only acknowledged locally isn't taken as
// delivered until the server shows it was.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { call } from "@agent-comms/comms-cli/client";
import { Bridge, run as grokbot, type InboxItem, socketClient, Store } from "@agent-comms/grokbot";
import { afterEach, describe, expect, it } from "vitest";
import { api } from "../../../convex/_generated/api.js";
import { ADMIN, machine, Mod, type Running, startConnector, until, world } from "./harness.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c().catch(() => {});
});

function bridgeIn(home: string, socket: string) {
  const store = new Store({ inboxDir: join(home, "inbox"), outboxDir: join(home, "outbox"), logFile: join(home, "log.jsonl"), stateFile: join(home, "state.json") });
  const bridge = new Bridge({
    config: { participant: "grok", cwd: home, pollWaitMs: 1_000, answerTimeoutMs: 600_000, unregisterOnExit: false, home },
    client: socketClient(socket),
    store,
    log: () => {},
    tickMs: 25,
    backoff: { initialMs: 20, maxMs: 200 },
  });
  return { bridge, store };
}

describe.skipIf(process.platform === "win32")("grokbot bridge with the real connector", () => {
  it("posts an answer as a reply when the request was made uncertain while Grok Bot was away", async () => {
    const w = await world();
    await w.t.mutation(api.directory.promote, {
      adminToken: ADMIN,
      name: "grok",
      kind: "agent",
      owner: "lee",
      home: { machine: machine.id, harness: "claude-code", locator: "grok" },
    });
    const connector: Running = await startConnector(w.api, w.socket);
    cleanups.push(() => connector.stop());
    const home = await mkdtemp(join(tmpdir(), "grokbot-real-"));
    cleanups.push(() => rm(home, { recursive: true, force: true }));

    // Grok Bot receives the request, then goes away before answering.
    const first = bridgeIn(home, w.socket);
    await first.store.init();
    await first.bridge.start();
    const sent = await call(w.socket, "send", { as: "a", to: ["grok"], text: "What's 6 times 7?" });
    if (!sent.ok) throw new Error(sent.error.message);
    const status = async () => {
      const r = await call(w.socket, "message-status", { as: "a", messageId: sent.message.id });
      if (!r.ok) throw new Error(r.error.message);
      return r.recipients.find((x) => x.participant.name === "grok")!;
    };
    await until("delivered", async () => (await status()).delivery?.state === "delivered");
    const deliveryId = (await status()).delivery!.id;
    await first.bridge.stop();

    // Meanwhile another session for @grok takes over and can't account for it: uncertain.
    const other = new Mod(w.socket, "grok", "other");
    await other.register();
    const check = await other.nextCheck();
    expect(check).toMatchObject({ deliveryId, state: "delivered" });
    await other.ok("check-result", { deliveryId, found: "unknown", detail: "not this session's turn" } as never);
    await until("uncertain", async () => (await status()).delivery?.state === "uncertain");

    // Grok Bot comes back and answers from its inbox. The connector acknowledges the outcome
    // locally, but the server never took it: the bridge must post the answer itself.
    const second = bridgeIn(home, w.socket);
    await second.bridge.start();
    cleanups.push(async () => void (await second.bridge.stop()));
    await until("registered again", async () => second.bridge.isRegistered);
    const answered = await grokbot(["--home", home, "--socket", w.socket, "answer", deliveryId, "42", "--no-wait"], {
      env: {},
      stdout: () => {},
      stderr: () => {},
      readStdin: async () => "",
    });
    expect([0, 4]).toContain(answered);
    const done = await until(
      "answer settled",
      async () => {
        const item = (await second.store.get(deliveryId)) as InboxItem | null;
        return item && ["replied", "replied-late"].includes(item.state) && item;
      },
      15_000,
    );
    expect(done.state).toBe("replied-late");
    const final = await status();
    expect(final.delivery?.state).toBe("replied");
    expect(final.answer?.text).toBe("42");
  });
});
