import { readFileSync } from "node:fs";
import { ConvexHttpClient } from "/srv/agents/cedar/agent-comms/node_modules/convex/dist/esm/browser/index.js";
const adminToken = readFileSync("/srv/agents/cedar/secrets/admin-token", "utf8").trim();
const c = new ConvexHttpClient("http://127.0.0.1:3240");
const { conversations } = await c.query("conversations:list", { adminToken });
const msgs = [];
for (const conv of conversations) for (const m of (await c.query("conversations:view", { adminToken, conversationId: conv.id, limit: 500 })).messages) msgs.push(m);
const kindOfDelivery = new Map();
for (const m of msgs) for (const d of m.deliveries) kindOfDelivery.set(d.id, m.message.kind);
const collected = msgs.filter((m) => m.message.collectedFrom);
const stateCounts = {};
for (const m of msgs) for (const d of m.deliveries) stateCounts[d.state] = (stateCounts[d.state] ?? 0) + 1;
console.log(JSON.stringify({
  messages: msgs.length,
  privateMarkerInConvex: msgs.filter((m) => m.message.text.includes("PRIVATE-ACC") || m.message.text.includes("PRIVATE-")).length,
  collectedAnswers: collected.length,
  collectedFromAnAnswerDelivery: collected.filter((m) => kindOfDelivery.get(m.message.collectedFrom) !== "request").length,
  answerDeliveriesEverCollectedOrAmbiguous: msgs.filter((m) => m.message.kind === "answer").flatMap((m) => m.deliveries).filter((d) => !["delivered", "pending", "claimed"].includes(d.state)).length,
  deliveryStates: stateCounts,
}, null, 1));
