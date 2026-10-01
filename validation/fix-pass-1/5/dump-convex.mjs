// Dumps this run's conversations (titles starting "fp1 ") with every message and delivery state.
import { writeFileSync } from "node:fs";
import { adminToken, convex, OUT } from "./lib.mjs";
const { conversations } = await convex.query("conversations:list", { adminToken });
const ours = conversations.filter((c) => c.kind === "group" && c.title?.startsWith("fp1 "));
const dump = [];
for (const c of ours) dump.push(await convex.query("conversations:view", { adminToken, conversationId: c.id, limit: 500 }));
writeFileSync(`${OUT}convex-dump.json`, JSON.stringify(dump, null, 1));
console.log(`${dump.length} conversations`);
