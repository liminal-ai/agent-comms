import { EXIT, run as comms } from "@agent-comms/comms-cli";
import { call } from "@agent-comms/comms-cli/client";
import { afterEach, expect, it } from "vitest";
import { api } from "../../../convex/_generated/api.js";
import { sweep } from "../../../convex/lib/waits";
import { ADMIN, Mod, type Running, sleep, startConnector, until, world } from "./harness.ts";
let running: Running[] = [];
afterEach(async () => { for (const r of running) await r.stop().catch(() => {}); running = []; });
for (const json of [false, true]) {
  it(`review: group wait, json=${json}: an answer printed early is it acked before the ack window?`, async () => {
    const w = await world();
    running.push(await startConnector(w.api, w.socket));
    const a = new Mod(w.socket, "a"); const b = new Mod(w.socket, "b");
    await a.register(); await b.register();
    await a.ok("presence", { status: "busy" } as never);
    await until("a busy", async () => (await w.t.query(api.directory.list, { adminToken: ADMIN })).participants.find((p) => p.name === "a")?.presence.status === "busy");
    const g = await w.t.mutation(api.conversations.createGroup, { adminToken: ADMIN, title: "g", members: ["a", "b", "tee"] } as never);
    const conversationId = (g as any).conversation?.id ?? (g as any).id ?? (g as any).conversationId;
    let stdout = "";
    const run = comms(["--socket", w.socket, "send", "--as", "a", ...(json ? ["--json"] : []), "--wait", "8s", "--conversation", conversationId, "@b", "@tee", "both?"], { env: {}, stdout: (t) => (stdout += t), stderr: () => {}, readStdin: async () => "" });
    const d = await b.nextDelivery();
    await b.ok("delivered", { deliveryId: d.id, turnId: "t1" } as never);
    await b.ok("outcome", { deliveryId: d.id, turnId: "t1", outcome: "replied", answer: "b's answer" } as never);
    await sleep(1500);
    // Simulate the minute sweep running once the ack window (2 min) has passed during a long --wait.
    const swept = await w.t.run(async (ctx) => sweep(ctx as never, Date.now() + 3 * 60_000));
    const code = await run;
    const id = json ? JSON.parse(stdout).message.id : /^sent (\S+)/m.exec(stdout)![1]!;
    const s = await call(w.socket, "message-status", { as: "a", messageId: id });
    const bState = s.ok && s.wait!.results.find((r) => r.recipient.name === "b")!.state;
    console.log(`json=${json}: exit ${code}; sweep ${JSON.stringify(swept)}; b's result ${bState}; b's answer printed: ${stdout.includes("b's answer")}`);
  }, 60_000);
}
