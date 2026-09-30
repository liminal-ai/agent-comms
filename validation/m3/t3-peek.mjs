// Prints only structural fields of a T3 thread (no message text, no token).
import { readFileSync } from "node:fs";
const [threadId, messageId] = process.argv.slice(2);
const token = readFileSync(process.env.HOME + "/.config/agent-comms/t3-3780.token", "utf8").trim();
const r = await fetch(`http://127.0.0.1:3780/api/orchestration/threads/${threadId}`, { headers: { authorization: `Bearer ${token}` } });
const { thread } = await r.json();
const ours = thread.messages.find((m) => m.id === messageId);
console.log(JSON.stringify({
  ours: ours && { createdAt: ours.createdAt, turnId: ours.turnId },
  latestTurn: thread.latestTurn,
  session: thread.session && { status: thread.session.status, activeTurnId: thread.session.activeTurnId },
  after: thread.messages.filter((m) => ours && m.createdAt >= ours.createdAt).map((m) => ({ role: m.role, turnId: m.turnId, createdAt: m.createdAt, id: m.id.slice(0, 24) })),
}, null, 1));
