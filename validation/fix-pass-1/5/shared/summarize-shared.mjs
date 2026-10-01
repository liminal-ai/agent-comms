// Shared checks 6 and 7, restricted to this run (Alder): computed from convex-dump-all.json only.
// This run = every message in [14:05, 14:25) UTC in a conversation with one of this run's homes
// (fp1-native, fp1-lhc, term-a). The conversations are listed in the output.
import { readFileSync, writeFileSync } from "node:fs";
const OUT = new URL(".", import.meta.url).pathname;
const dump = JSON.parse(readFileSync(`${OUT}convex-dump-all.json`, "utf8"));
const start = Date.parse(readFileSync(`${OUT}../shared-start.txt`, "utf8").trim());
const end = Date.parse("2026-10-01T14:25:00Z");
const HOMES = new Set(["fp1-native", "fp1-lhc", "term-a"]);

const runConversations = dump.filter((v) => v.members.some((m) => HOMES.has(m.name)) && v.messages.some((m) => m.message.createdAt >= start && m.message.createdAt < end));
const messages = runConversations.flatMap((v) => v.messages.filter((m) => m.message.createdAt >= start && m.message.createdAt < end).map((m) => ({ conversation: v.conversation, ...m })));
const kindOf = new Map(dump.flatMap((v) => v.messages.flatMap((m) => m.deliveries.map((d) => [d.id, m.message.kind]))));
const collected = messages.filter((m) => m.message.collectedFrom);
const answers = messages.filter((m) => m.message.kind === "answer");

const summary = {
  window: [new Date(start).toISOString(), new Date(end).toISOString()],
  conversations: runConversations.map((v) => ({ id: v.conversation.id, title: v.conversation.title ?? "dm", members: v.members.map((m) => m.name) })),
  messages: messages.length,
  "6 withPrivateMarker": messages.filter((m) => /PRIVATE-ACC2?/.test(m.message.text)).length,
  "7 collectedAnswers": collected.length,
  "7 collectedFromAnAnswersDelivery": collected.filter((m) => kindOf.get(m.message.collectedFrom) !== "request").length,
  "7 answerDeliveries": answers.flatMap((m) => m.deliveries).length,
  "7 answerDeliveriesPastDelivered": answers.flatMap((m) => m.deliveries).filter((d) => !["pending", "claimed", "delivered"].includes(d.state)).length,
};
writeFileSync(`${OUT}summary-shared.json`, JSON.stringify(summary, null, 1));
console.log(JSON.stringify(summary, null, 1));
