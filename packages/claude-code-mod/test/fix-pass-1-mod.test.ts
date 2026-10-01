// Fix pass 1, section 1, mod-level items (1.8, 1.9) against the connector stub.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { JOURNAL_LOSS_WINDOW_MS } from "../hooks/core/mod.ts";
import { FakeSession, makeMod, pumpUntil, stubOps, until, useStub, wrap } from "./support.ts";

const ctx = useStub("comms-mod-fp1-");
const { post, deliveryState } = stubOps(ctx);

describe("1.8 journal safety", () => {
  it("1.8: if the journal can't be written, nothing is submitted and the delivery fails", async () => {
    const session = new FakeSession(ctx.socketPath);
    const mod = makeMod(session);
    await mod.start();
    session.journalWritable = false;
    const sent = await post({ sender: "mod-b", to: ["mod-a"], text: "do the thing" });
    const id = sent.deliveries[0].id;
    await pumpUntil(mod, async () => (await deliveryState(id)) === "failed", "the failure");
    assert.equal(session.submitted.length, 0, "never submitted");
    assert.equal(session.ops("outcome")[0]?.reason, "rejected");
  });

  it("1.8: with an unreadable journal, a check for an unknown delivery is unknown, never no (even with no header in the transcript)", async () => {
    const session = new FakeSession(ctx.socketPath);
    session.journal = '{"participant":"mod-a","deliveries":[{"deliveryId":"d_';
    const mod = makeMod(session);
    await mod.start();
    await (mod as any).check({ deliveryId: "d_gone", messageId: "m_gone", state: "claimed" });
    await until(() => session.ops("check-result").length === 1, "the check result");
    assert.equal(session.ops("check-result")[0].found, "unknown");
  });

  it("1.8 (Alder): with no journal file, a check for an unknown delivery is unknown, never no", async () => {
    const session = new FakeSession(ctx.socketPath);
    session.journal = null; // missing
    const mod = makeMod(session);
    await mod.start();
    await (mod as any).check({ deliveryId: "d_missing", messageId: "m_missing", state: "claimed" });
    await until(() => session.ops("check-result").length === 1, "the check result");
    assert.equal(session.ops("check-result")[0].found, "unknown");
  });

  it("1.8 (Alder): with an empty journal file, a check for an unknown delivery is unknown, never no", async () => {
    const session = new FakeSession(ctx.socketPath);
    session.journal = ""; // created but never written (or truncated)
    const mod = makeMod(session);
    await mod.start();
    await (mod as any).check({ deliveryId: "d_empty", messageId: "m_empty", state: "claimed" });
    await until(() => session.ops("check-result").length === 1, "the check result");
    assert.equal(session.ops("check-result")[0].found, "unknown");
  });

  it("1.8: a lost journal stays inconclusive across sessions until the loss window ends", async () => {
    const first = new FakeSession(ctx.socketPath);
    first.journal = null;
    const mod1 = makeMod(first, "sess-1");
    await mod1.start();
    await post({ sender: "mod-b", to: ["mod-a"], text: "write the journal" });
    await pumpUntil(mod1, () => first.submitted.length === 1, "a submission writes the journal");
    assert.match(first.journal ?? "", /incompleteUntil/);

    // A later session reads that journal: still inconclusive inside the window...
    const second = new FakeSession(ctx.socketPath);
    second.journal = first.journal;
    const mod2 = makeMod(second, "sess-2");
    await mod2.start();
    await (mod2 as any).check({ deliveryId: "d_unseen", messageId: "m_unseen", state: "claimed" });
    await until(() => second.ops("check-result").length === 1, "the check result");
    assert.equal(second.ops("check-result")[0].found, "unknown");

    // ...and conclusive after it.
    const third = new FakeSession(ctx.socketPath);
    third.journal = first.journal;
    third.clock = first.clock + JOURNAL_LOSS_WINDOW_MS + 1;
    const mod3 = makeMod(third, "sess-3");
    await mod3.start();
    await (mod3 as any).check({ deliveryId: "d_unseen", messageId: "m_unseen", state: "claimed" });
    await until(() => third.ops("check-result").length === 1, "the check result");
    assert.equal(third.ops("check-result")[0].found, "no");
  });

  it("1.8: a delivery another session of this participant journaled after we loaded is seen at check time", async () => {
    const shared = { journal: null as string | null };
    const a = new FakeSession(ctx.socketPath);
    const b = new FakeSession(ctx.socketPath);
    // Both sessions read and write the same journal file.
    for (const s of [a, b]) {
      const host = s.host.bind(s);
      s.host = () => ({
        ...host(),
        loadJournal: async () => shared.journal,
        saveJournal: async (text: string) => {
          shared.journal = text;
        },
      });
    }
    const modB = makeMod(b, "sess-b");
    await modB.start(); // loads an empty journal
    const modA = makeMod(a, "sess-a");
    await modA.start(); // supersedes b
    const sent = await post({ sender: "mod-b", to: ["mod-a"], text: "run" });
    await pumpUntil(modA, () => a.submitted.length === 1, "a submits");
    const id = sent.deliveries[0].id;
    await (modB as any).check({ deliveryId: id, messageId: sent.message.id, state: "claimed" });
    await until(() => b.ops("check-result").length === 1, "b's check result");
    assert.notEqual(b.ops("check-result")[0].found, "no");
  });
});

describe("1.9 more than 50 entered inputs", () => {
  it("1.9: an ambiguous report with 60 inputs is accepted, not dropped", async () => {
    const session = new FakeSession(ctx.socketPath);
    const mod = makeMod(session);
    await mod.start();
    const sent = await post({ sender: "mod-b", to: ["mod-a"], text: "busy" });
    const id = sent.deliveries[0].id;
    await pumpUntil(mod, () => session.submitted.length === 1, "the submission");
    mod.onTurnStart("t1", wrap(session.submitted[0]!));
    for (let i = 0; i < 60; i++) mod.onPromptSubmit({ turnId: "t1", origin: { kind: "composer" }, text: `x${i}` });
    mod.onTurnComplete({ turnId: "t1", reason: "answer", answer: "ok" });
    session.clock += 10_000;
    await pumpUntil(mod, async () => (await deliveryState(id)) === "ambiguous", "ambiguous recorded");
  });
});
