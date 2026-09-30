import type { Delivery, MessageEnvelope, ParticipantRef } from "../src/index.ts";

export const reed: ParticipantRef = { id: "p_reed", name: "reed", kind: "agent" };
export const cedar: ParticipantRef = { id: "p_cedar", name: "cedar", kind: "agent" };
export const hazel: ParticipantRef = { id: "p_hazel", name: "hazel", kind: "agent" };
export const lee: ParticipantRef = { id: "p_lee", name: "lee", kind: "human" };

export function message(overrides: Partial<MessageEnvelope> & { seq: number }): MessageEnvelope {
  return {
    id: `m_${overrides.seq}`,
    conversationId: "c_1",
    sender: reed,
    recipients: [cedar],
    kind: "request",
    text: `message ${overrides.seq}`,
    attachments: [],
    createdAt: 1_790_000_000_000 + overrides.seq,
    origin: { via: "cli" },
    ...overrides,
  };
}

export function delivery(overrides: Partial<Delivery> = {}): Delivery {
  return {
    id: "d_1",
    recipient: cedar,
    conversation: { id: "c_1", kind: "dm" },
    message: message({ seq: 3, text: "Please review the envelope." }),
    history: { messages: [], omitted: 0 },
    status: { state: "claimed", at: 1_790_000_000_100 },
    ...overrides,
  };
}
