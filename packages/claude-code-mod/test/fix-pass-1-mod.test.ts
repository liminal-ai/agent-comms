// Fix pass 1, section 1, mod-level items (1.8, 1.9) against the connector stub.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CLOCK_SKEW_MS } from "../hooks/core/mod.ts";
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

  it("1.8: the loss time is kept across sessions; checks without a creation time stay unknown after a loss", async () => {
    const first = new FakeSession(ctx.socketPath);
    first.journal = null;
    const mod1 = makeMod(first, "sess-1");
    await mod1.start();
    const lostAt = first.clock;
    assert.equal(JSON.parse(first.journal ?? "{}").historyLostAt, lostAt, "the journal is written at once with the loss time");

    const second = new FakeSession(ctx.socketPath);
    second.journal = first.journal;
    second.clock = lostAt + 30 * 24 * 60 * 60 * 1000; // a month later
    const mod2 = makeMod(second, "sess-2");
    await mod2.start();
    await (mod2 as any).check({ deliveryId: "d_nodate", messageId: "m_nodate", state: "claimed" });
    await (mod2 as any).check({ deliveryId: "d_before", messageId: "m_before", state: "claimed", createdAt: lostAt - 1 });
    await (mod2 as any).check({ deliveryId: "d_after", messageId: "m_after", state: "claimed", createdAt: lostAt + CLOCK_SKEW_MS + 1 });
    await until(() => second.ops("check-result").length === 3, "three check results");
    assert.deepEqual(
      second.ops("check-result").map((c) => [c.deliveryId, c.found]),
      [
        ["d_nodate", "unknown"],
        ["d_before", "unknown"],
        ["d_after", "no"],
      ],
    );
  });

  it("1.8 (Reed): a delivery created before the journal was lost is unknown even when checked more than 24 h later", async () => {
    const session = new FakeSession(ctx.socketPath);
    const createdBeforeLoss = session.clock - 60_000;
    session.journal = null; // history lost now
    const mod = makeMod(session);
    await mod.start();
    // The journal is written again after the loss (a later submission)...
    await post({ sender: "mod-b", to: ["mod-a"], text: "journal written after the loss" });
    await pumpUntil(mod, () => session.submitted.length === 1, "a submission writes the journal");
    session.clock += 25 * 60 * 60 * 1000; // ...and the connector was down for over a day
    await (mod as any).check({ deliveryId: "d_old", messageId: "m_old", state: "claimed", createdAt: createdBeforeLoss });
    await until(() => session.ops("check-result").length === 1, "the check result");
    assert.equal(session.ops("check-result")[0].found, "unknown");
  });

  it("1.8 (Reed): a delivery created after the loss, absent from the journal, is no", async () => {
    const session = new FakeSession(ctx.socketPath);
    session.journal = null;
    const mod = makeMod(session);
    await mod.start(); // loss recorded at this clock
    await post({ sender: "mod-b", to: ["mod-a"], text: "journal written" });
    await pumpUntil(mod, () => session.submitted.length === 1, "a submission writes the journal");
    const createdAfterLoss = session.clock + CLOCK_SKEW_MS + 60_000;
    session.clock = createdAfterLoss + 1_000;
    await (mod as any).check({ deliveryId: "d_new", messageId: "m_new", state: "claimed", createdAt: createdAfterLoss });
    await until(() => session.ops("check-result").length === 1, "the check result");
    assert.equal(session.ops("check-result")[0].found, "no");
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
