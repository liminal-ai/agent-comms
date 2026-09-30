import { readFileSync } from "node:fs";
const token = readFileSync(process.env.HOME + "/.config/agent-comms/t3-3780.token", "utf8").trim();
const id = process.argv[2];
const { thread } = await (await fetch(`http://127.0.0.1:3780/api/orchestration/threads/${id}?turnLimit=2`, { headers: { authorization: `Bearer ${token}` } })).json();
const lt = thread.latestTurn;
const msgs = thread.messages.filter((m) => m.turnId === lt.turnId || m.role === "user").slice(-6);
console.log(JSON.stringify({ latestTurn: lt, session: thread.session?.status, msgs: msgs.map((m) => ({ id: m.id.slice(0, 30), role: m.role, turnId: m.turnId?.slice(0, 8) ?? null, streaming: m.streaming, len: m.text.length, at: m.createdAt })) }, null, 1));
