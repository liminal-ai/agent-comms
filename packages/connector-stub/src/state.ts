// The stub's comms record: a small in-memory stand-in for Convex, with the
// same rules the real server will have (addressed wakes, answers never
// collected, at most one collected answer per delivery, serial delivery per
// participant, checks instead of blind re-runs after a restart). Optionally
// persisted to a JSON file so a restarted stub behaves like a restarted
// connector: sessions are gone, deliveries aren't.

import {
  type AttachmentRef,
  boundHistory,
  clipAnswer,
  type ConversationRef,
  type ConversationSummary,
  type Delivery,
  type DeliveryCheck,
  type DeliveryState,
  type DeliveryStateRef,
  type DeliveryStatus,
  type ErrorCode,
  type Home,
  type HomedParticipant,
  type MessageEnvelope,
  type MessageKind,
  type OutcomeBody,
  type ParticipantKind,
  type ParticipantRef,
  type ParticipantState,
  type PollItem,
  type Requests,
  type Responses,
  type SendResult,
  type Via,
} from "@agent-comms/protocol";

export class StubError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export interface StubParticipant {
  ref: ParticipantRef;
  home: Home;
  state: ParticipantState;
}

export interface StubConversation {
  ref: ConversationRef;
  members: { participantId: string; readSeq: number }[];
  lastSeq: number;
  lastAt: number;
}

export interface StubDelivery {
  id: string;
  messageId: string;
  recipientId: string;
  status: DeliveryStatus;
  /** The collected answer, once replied from the turn. */
  answerMessageId?: string;
}

export interface StubRecord {
  machine: string;
  counters: { conversation: number; message: number; delivery: number; claim: number };
  participants: StubParticipant[];
  conversations: StubConversation[];
  messages: MessageEnvelope[];
  deliveries: StubDelivery[];
}

interface Session {
  id: string;
  participantId: string;
  cwd: string;
  status: "idle" | "busy";
  superseded: boolean;
  polling: boolean;
  checks: DeliveryCheck[];
  offered: Set<string>;
}

export interface FixtureParticipant {
  name: string;
  kind?: ParticipantKind;
  state?: ParticipantState;
  /** Defaults to this machine, Claude Code, locator = name. */
  home?: Partial<Home>;
}

export interface Fixture {
  machine?: string;
  participants: FixtureParticipant[];
  conversations?: { id: string; kind: "dm" | "group"; title?: string; members: string[] }[];
  /** Posted in order at startup, as if sent by `sender`. */
  messages?: PostInput[];
}

export interface PostInput {
  sender: string;
  to: string[];
  conversationId?: string;
  text: string;
  kind?: MessageKind;
  inReplyTo?: string;
  via?: Via;
  attachments?: AttachmentRef[];
}

type Listener = () => void;

export class StubComms {
  readonly record: StubRecord;
  private readonly sessions = new Map<string, Session>();
  /** Idempotency keys seen, by "<sender>/<key>" (fix pass 3.1). */
  private readonly keyed = new Map<string, SendResult>();
  private readonly listeners = new Set<Listener>();
  private readonly now: () => number;
  private readonly onChange: (record: StubRecord) => void;

  constructor(record: StubRecord, options: { now?: () => number; onChange?: (record: StubRecord) => void } = {}) {
    this.record = record;
    this.now = options.now ?? Date.now;
    this.onChange = options.onChange ?? (() => {});
  }

  static fromFixture(fixture: Fixture, options: { machine?: string; now?: () => number } = {}): StubComms {
    const machine = options.machine ?? fixture.machine ?? "stub";
    const record: StubRecord = {
      machine,
      counters: { conversation: 0, message: 0, delivery: 0, claim: 0 },
      participants: fixture.participants.map((p) => ({
        ref: { id: `p_${p.name}`, name: p.name, kind: p.kind ?? "agent" },
        home: { machine, harness: "claude-code", locator: p.name, ...p.home },
        state: p.state ?? "active",
      })),
      conversations: [],
      messages: [],
      deliveries: [],
    };
    const comms = new StubComms(record, options.now ? { now: options.now } : {});
    for (const c of fixture.conversations ?? []) {
      record.conversations.push({
        ref: { id: c.id, kind: c.kind, ...(c.title ? { title: c.title } : {}) },
        members: c.members.map((name) => ({ participantId: comms.participant(name).ref.id, readSeq: 0 })),
        lastSeq: 0,
        lastAt: 0,
      });
    }
    for (const m of fixture.messages ?? []) comms.post(m);
    return comms;
  }

  /** Called whenever something a waiting poll might want changes. */
  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed(): void {
    this.onChange(this.record);
    for (const listener of [...this.listeners]) listener();
  }

  // -------------------------------------------------------------------------
  // Lookups

  participant(name: string): StubParticipant {
    const p = this.record.participants.find((x) => x.ref.name === name);
    if (!p) throw new StubError("unknown_participant", `no participant named @${name}`);
    return p;
  }

  private participantById(id: string): StubParticipant {
    const p = this.record.participants.find((x) => x.ref.id === id);
    if (!p) throw new StubError("internal", `participant ${id} missing`);
    return p;
  }

  /** `--as`: accepted if homed on this machine. A trusted-machine shortcut, not proof of identity. */
  private actingAs(name: string): StubParticipant {
    const p = this.participant(name);
    if (p.home.machine !== this.record.machine) {
      throw new StubError("not_homed_here", `@${name} is homed on ${p.home.machine}, not ${this.record.machine}`);
    }
    return p;
  }

  private conversation(id: string): StubConversation {
    const c = this.record.conversations.find((x) => x.ref.id === id);
    if (!c) throw new StubError("unknown_conversation", `no conversation ${id}`);
    return c;
  }

  private message(id: string): MessageEnvelope {
    const m = this.record.messages.find((x) => x.id === id);
    if (!m) throw new StubError("unknown_message", `no message ${id}`);
    return m;
  }

  private delivery(id: string): StubDelivery {
    const d = this.record.deliveries.find((x) => x.id === id);
    if (!d) throw new StubError("unknown_delivery", `no delivery ${id}`);
    return d;
  }

  private member(conversation: StubConversation, participant: StubParticipant) {
    const m = conversation.members.find((x) => x.participantId === participant.ref.id);
    if (!m) throw new StubError("not_member", `@${participant.ref.name} is not a member of ${conversation.ref.id}`);
    return m;
  }

  private session(id: string): Session {
    const s = this.sessions.get(id);
    if (!s) throw new StubError("unknown_session", `session ${id} is not registered; register again`);
    if (s.superseded) throw new StubError("session_superseded", `session ${id} was replaced by a newer session`);
    return s;
  }

  // -------------------------------------------------------------------------
  // Posting (shared by send, reply, collected answers, fixtures and /stub/post)

  post(input: PostInput): SendResult {
    const sender = this.participant(input.sender);
    const kind = input.kind ?? "request";
    const recipients = input.to.map((name) => this.participant(name));
    if (recipients.some((r) => r.ref.id === sender.ref.id)) throw new StubError("bad_request", "can't address yourself");

    let conversation: StubConversation;
    if (input.conversationId) {
      conversation = this.conversation(input.conversationId);
      this.member(conversation, sender);
      for (const r of recipients) this.member(conversation, r);
    } else {
      const [other, ...rest] = recipients;
      if (!other || rest.length > 0) {
        throw new StubError("bad_request", "without a conversation id, address exactly one participant (a DM)");
      }
      conversation = this.dm(sender, other);
    }

    const seq = conversation.lastSeq + 1;
    const message: MessageEnvelope = {
      id: `m_${++this.record.counters.message}`,
      conversationId: conversation.ref.id,
      seq,
      sender: sender.ref,
      recipients: recipients.map((r) => r.ref),
      kind,
      ...(input.inReplyTo ? { inReplyTo: input.inReplyTo } : {}),
      text: input.text,
      attachments: input.attachments ?? [],
      createdAt: this.now(),
      origin: { via: input.via ?? "cli" },
    };
    this.record.messages.push(message);
    conversation.lastSeq = seq;
    conversation.lastAt = message.createdAt;
    this.member(conversation, sender).readSeq = seq;

    const result = this.createDeliveries(message, recipients);
    this.changed();
    return result;
  }

  private dm(a: StubParticipant, b: StubParticipant): StubConversation {
    const existing = this.record.conversations.find(
      (c) =>
        c.ref.kind === "dm" &&
        c.members.length === 2 &&
        c.members.some((m) => m.participantId === a.ref.id) &&
        c.members.some((m) => m.participantId === b.ref.id),
    );
    if (existing) return existing;
    const created: StubConversation = {
      ref: { id: `c_${++this.record.counters.conversation}`, kind: "dm" },
      members: [a, b].map((p) => ({ participantId: p.ref.id, readSeq: 0 })),
      lastSeq: 0,
      lastAt: 0,
    };
    this.record.conversations.push(created);
    return created;
  }

  /** Addressed wakes: one delivery per addressed agent. Retired get none; paused wait. Humans read in the web view. */
  private createDeliveries(message: MessageEnvelope, recipients: StubParticipant[]): SendResult {
    const result: SendResult = { message, deliveries: [], skipped: [] };
    for (const r of recipients) {
      if (r.state === "retired") {
        result.skipped.push({ name: r.ref.name, reason: "retired" });
        continue;
      }
      if (r.ref.kind === "human") continue;
      const d: StubDelivery = {
        id: `d_${++this.record.counters.delivery}`,
        messageId: message.id,
        recipientId: r.ref.id,
        status: { state: "pending", at: this.now() },
      };
      this.record.deliveries.push(d);
      result.deliveries.push(this.stateRef(d));
    }
    return result;
  }

  private stateRef(d: StubDelivery): DeliveryStateRef {
    return { id: d.id, recipient: this.participantById(d.recipientId).ref.name, state: d.status.state };
  }

  private setState(d: StubDelivery, state: DeliveryState, extra: Partial<DeliveryStatus> = {}): void {
    d.status = { state, at: this.now(), ...extra };
  }

  // -------------------------------------------------------------------------
  // Loopback operations

  status(): Responses["status"] {
    const here: HomedParticipant[] = this.record.participants
      .filter((p) => p.home.machine === this.record.machine)
      .map((p) => ({ participant: p.ref, home: p.home, state: p.state }));
    return { protocol: 1, implementation: "stub", machine: this.record.machine, participants: here };
  }

  register(req: Requests["register"], pollWaitMs: number): Responses["register"] {
    const p = this.participant(req.participant);
    if (p.home.machine !== this.record.machine || p.home.harness !== "claude-code") {
      throw new StubError(
        "not_homed_here",
        `@${p.ref.name} is homed at ${p.home.harness} on ${p.home.machine}, not claude-code on ${this.record.machine}`,
      );
    }
    for (const other of this.sessions.values()) {
      if (other.participantId === p.ref.id && other.id !== req.sessionId) other.superseded = true;
    }
    const session: Session = {
      id: req.sessionId,
      participantId: p.ref.id,
      cwd: req.cwd,
      status: req.status,
      superseded: false,
      polling: this.sessions.get(req.sessionId)?.polling ?? false,
      checks: this.restartChecks(p),
      offered: new Set(),
    };
    this.sessions.set(req.sessionId, session);
    this.changed();
    return { participant: p.ref, pollWaitMs };
  }

  /**
   * A new registration never re-runs anything blind: whatever was handed out
   * before and hasn't finished is asked about first.
   */
  private restartChecks(p: StubParticipant): DeliveryCheck[] {
    const checks: DeliveryCheck[] = [];
    for (const d of this.record.deliveries) {
      if (d.recipientId !== p.ref.id) continue;
      const kind = this.message(d.messageId).kind;
      if (d.status.state === "claimed") {
        checks.push({ deliveryId: d.id, messageId: d.messageId, state: "claimed", createdAt: this.message(d.messageId).createdAt });
      } else if (d.status.state === "delivered" && kind === "request") {
        checks.push({
          deliveryId: d.id,
          messageId: d.messageId,
          state: "delivered",
          createdAt: this.message(d.messageId).createdAt,
          ...(d.status.turnId ? { turnId: d.status.turnId } : {}),
        });
      }
    }
    return checks;
  }

  unregister(req: Requests["unregister"]): Responses["unregister"] {
    this.sessions.delete(req.sessionId);
    this.changed();
    return {};
  }

  /** Starts a poll; throws if one is already outstanding for the session. */
  beginPoll(sessionId: string): void {
    const s = this.session(sessionId);
    if (s.polling) throw new StubError("poll_in_progress", "a poll is already outstanding for this session");
    s.polling = true;
  }

  endPoll(sessionId: string): void {
    const s = this.sessions.get(sessionId);
    if (s) s.polling = false;
  }

  /** Items ready for the session now: pending checks first, then at most one delivery. Marks what it hands out. */
  takeItems(sessionId: string): PollItem[] {
    const s = this.session(sessionId);
    const items: PollItem[] = s.checks.map((check) => ({ type: "check", check }));
    s.checks = [];
    const p = this.participantById(s.participantId);
    if (p.state === "active" && !this.inFlight(p) && items.length === 0) {
      const next = this.record.deliveries.find((d) => d.recipientId === p.ref.id && d.status.state === "pending");
      if (next) {
        this.setState(next, "claimed", {
          claim: {
            machine: this.record.machine,
            claimId: `k_${++this.record.counters.claim}`,
            leaseExpiresAt: this.now() + 10 * 60_000,
          },
        });
        s.offered.add(next.id);
        items.push({ type: "deliver", delivery: this.render(next) });
      }
    }
    if (items.length > 0) this.changed();
    return items;
  }

  /** Serial per participant: nothing new while a delivery is handed out or its request turn is running. */
  private inFlight(p: StubParticipant): boolean {
    return this.record.deliveries.some(
      (d) =>
        d.recipientId === p.ref.id &&
        (d.status.state === "claimed" ||
          (d.status.state === "delivered" && this.message(d.messageId).kind === "request")),
    );
  }

  hasItems(sessionId: string): boolean {
    const s = this.sessions.get(sessionId);
    if (!s || s.superseded) return true; // let the poll answer with the error
    if (s.checks.length > 0) return true;
    const p = this.participantById(s.participantId);
    return (
      p.state === "active" &&
      !this.inFlight(p) &&
      this.record.deliveries.some((d) => d.recipientId === p.ref.id && d.status.state === "pending")
    );
  }

  private render(d: StubDelivery): Delivery {
    const message = this.message(d.messageId);
    const recipient = this.participantById(d.recipientId);
    const conversation = this.conversation(message.conversationId);
    const member = this.member(conversation, recipient);
    const unread = this.record.messages.filter(
      (m) => m.conversationId === conversation.ref.id && m.seq > member.readSeq && m.seq < message.seq,
    );
    member.readSeq = Math.max(member.readSeq, message.seq);
    const inReplyTo = message.inReplyTo
      ? this.record.messages.find((m) => m.id === message.inReplyTo)
      : undefined;
    return {
      id: d.id,
      recipient: recipient.ref,
      conversation: conversation.ref,
      message,
      ...(inReplyTo ? { inReplyTo } : {}),
      history: boundHistory(unread),
      status: d.status,
    };
  }

  /** A delivery touched through a session must belong to that session's participant. */
  private ownDelivery(session: Session, deliveryId: string): StubDelivery {
    const d = this.delivery(deliveryId);
    if (d.recipientId !== session.participantId) {
      throw new StubError("conflict", `delivery ${deliveryId} is not addressed to this session's participant`);
    }
    return d;
  }

  delivered(req: Requests["delivered"]): Responses["delivered"] {
    const s = this.session(req.sessionId);
    const d = this.ownDelivery(s, req.deliveryId);
    if (d.status.state === "claimed") {
      this.setState(d, "delivered", { turnId: req.turnId });
      this.changed();
    } else if (d.status.turnId !== req.turnId) {
      throw new StubError(
        "conflict",
        `delivery ${d.id} is ${d.status.state}${d.status.turnId ? ` in turn ${d.status.turnId}` : ""}`,
      );
    }
    return { delivery: this.stateRef(d) };
  }

  outcome(req: Requests["outcome"]): Responses["outcome"] {
    const s = this.session(req.sessionId);
    const d = this.ownDelivery(s, req.deliveryId);
    return this.applyOutcome(d, req.turnId, req);
  }

  private applyOutcome(d: StubDelivery, turnId: string | undefined, body: OutcomeBody): Responses["outcome"] {
    const request = this.message(d.messageId);
    if (request.kind !== "request") {
      throw new StubError("conflict", `delivery ${d.id} carries an answer; answers are never collected`);
    }
    if (d.status.state === "replied" && body.outcome === "replied" && d.answerMessageId) {
      return { delivery: this.stateRef(d), answerMessageId: d.answerMessageId, duplicate: true };
    }
    if (d.status.state !== "claimed" && d.status.state !== "delivered") {
      throw new StubError("conflict", `delivery ${d.id} is already ${d.status.state}`);
    }
    if (d.status.turnId && turnId && d.status.turnId !== turnId) {
      throw new StubError("conflict", `delivery ${d.id} went into turn ${d.status.turnId}, not ${turnId}`);
    }
    if (body.outcome === "replied") {
      const recipient = this.participantById(d.recipientId);
      const answer = this.post({
        sender: recipient.ref.name,
        to: request.sender.id === recipient.ref.id ? [] : [request.sender.name],
        conversationId: request.conversationId,
        text: clipAnswer(body.answer),
        kind: "answer",
        inReplyTo: request.id,
        via: "claude-code",
      }).message;
      answer.collectedFrom = d.id;
      d.answerMessageId = answer.id;
      this.setState(d, "replied", turnId ? { turnId } : {});
      this.changed();
      return { delivery: this.stateRef(d), answerMessageId: answer.id, duplicate: false };
    }
    if (body.outcome === "ambiguous") {
      const what = body.entered.map((e) => e.origin).join(", ") || "other input";
      this.setState(d, "ambiguous", { ...(turnId ? { turnId } : {}), detail: `other input entered the turn: ${what}` });
    } else {
      this.setState(d, "failed", { ...(turnId ? { turnId } : {}), detail: body.detail ? `${body.reason}: ${body.detail}` : body.reason });
    }
    this.changed();
    return { delivery: this.stateRef(d), duplicate: false };
  }

  checkResult(req: Requests["check-result"]): Responses["check-result"] {
    const s = this.session(req.sessionId);
    const d = this.ownDelivery(s, req.deliveryId);
    if (d.status.state !== "claimed" && d.status.state !== "delivered") {
      return { delivery: this.stateRef(d) };
    }
    if (req.found === "no") {
      // Clearly absent: run it. Back to pending; the next poll offers it again.
      if (d.status.state === "claimed") this.setState(d, "pending");
      else this.setState(d, "uncertain", { detail: "the turn it was delivered into can't be found" });
    } else if (req.found === "unknown") {
      this.setState(d, "uncertain", { detail: req.detail ?? "the session couldn't tell whether it ran" });
    } else if (req.turn === "running") {
      if (d.status.state === "claimed") this.setState(d, "delivered", { turnId: req.turnId });
    } else {
      if (d.status.state === "claimed") this.setState(d, "delivered", { turnId: req.turnId });
      if (this.message(d.messageId).kind === "request") {
        if (req.outcome) this.applyOutcome(d, req.turnId, req.outcome);
        else this.setState(d, "uncertain", { turnId: req.turnId, detail: "its turn completed but no outcome was reported" });
      }
    }
    this.changed();
    return { delivery: this.stateRef(d) };
  }

  presence(req: Requests["presence"]): Responses["presence"] {
    this.session(req.sessionId).status = req.status;
    return {};
  }

  send(req: Requests["send"]): Responses["send"] {
    this.actingAs(req.as);
    return this.once(req.as, req.key, () => this.post({
      sender: req.as,
      to: req.to,
      ...(req.conversationId ? { conversationId: req.conversationId } : {}),
      text: req.text,
      // Set before the message exists, so no delivery is handed out without them (3.7).
      ...(req.attachments ? { attachments: req.attachments } : {}),
    }));
  }

  private once<T extends SendResult>(sender: string, key: string | undefined, run: () => T): T {
    if (key === undefined) return run();
    const id = `${sender}/${key}`;
    const earlier = this.keyed.get(id);
    if (earlier) return earlier as T;
    const result = run();
    this.keyed.set(id, result);
    return result;
  }

  reply(req: Requests["reply"]): Responses["reply"] {
    return this.once(req.as, req.key, () => this.replyOnce(req));
  }

  private replyOnce(req: Requests["reply"]): Responses["reply"] {
    const me = this.actingAs(req.as);
    const original = this.message(req.messageId);
    this.member(this.conversation(original.conversationId), me);
    const result: Responses["reply"] = this.post({
      sender: req.as,
      to: original.sender.id === me.ref.id ? [] : [original.sender.name],
      conversationId: original.conversationId,
      text: req.text,
      kind: "answer",
      inReplyTo: original.id,
      ...(req.attachments ? { attachments: req.attachments } : {}),
    });
    const open = this.record.deliveries.find(
      (d) =>
        d.messageId === original.id &&
        d.recipientId === me.ref.id &&
        (d.status.state === "ambiguous" || d.status.state === "uncertain"),
    );
    if (open) {
      this.setState(open, "replied", {
        ...(open.status.turnId ? { turnId: open.status.turnId } : {}),
        detail: `completed by comms reply ${result.message.id}`,
      });
      result.completed = open.id;
      this.changed();
    }
    return result;
  }

  read(req: Requests["read"]): Responses["read"] {
    const me = this.actingAs(req.as);
    const conversation = this.conversation(req.conversationId);
    const member = this.member(conversation, me);
    const limit = req.limit ?? 20;
    const all = this.record.messages
      .filter((m) => m.conversationId === conversation.ref.id && (req.before === undefined || m.seq < req.before))
      .sort((a, b) => a.seq - b.seq);
    const messages = all.slice(-limit);
    const newest = messages.at(-1);
    if (req.before === undefined && newest) {
      member.readSeq = Math.max(member.readSeq, newest.seq);
      this.changed();
    }
    return { conversation: this.summary(conversation, me), messages, hasMore: all.length > messages.length };
  }

  list(req: Requests["list"]): Responses["list"] {
    const me = this.actingAs(req.as);
    const conversations = this.record.conversations
      .filter((c) => c.members.some((m) => m.participantId === me.ref.id))
      .sort((a, b) => b.lastAt - a.lastAt)
      .map((c) => this.summary(c, me));
    return { conversations };
  }

  private summary(c: StubConversation, me: StubParticipant): ConversationSummary {
    const readSeq = this.member(c, me).readSeq;
    return {
      ...c.ref,
      members: c.members.map((m) => this.participantById(m.participantId).ref),
      lastSeq: c.lastSeq,
      readSeq,
      unread: c.lastSeq - readSeq,
    };
  }

  // -------------------------------------------------------------------------
  // Stub-only controls

  /** Ask the participant's current session about a delivery, as a restarted connector would. */
  queueCheck(deliveryId: string): DeliveryCheck {
    const d = this.delivery(deliveryId);
    if (d.status.state !== "claimed" && d.status.state !== "delivered") {
      throw new StubError("conflict", `delivery ${d.id} is ${d.status.state}; only claimed or delivered ones are checked`);
    }
    const session = [...this.sessions.values()].find((s) => s.participantId === d.recipientId && !s.superseded);
    if (!session) throw new StubError("conflict", "no session registered for that delivery's recipient");
    const check: DeliveryCheck = {
      deliveryId: d.id,
      messageId: d.messageId,
      state: d.status.state,
      createdAt: this.message(d.messageId).createdAt,
      ...(d.status.turnId ? { turnId: d.status.turnId } : {}),
    };
    session.checks.push(check);
    this.changed();
    return check;
  }

  sessionsView() {
    return [...this.sessions.values()].map((s) => ({
      id: s.id,
      participant: this.participantById(s.participantId).ref.name,
      cwd: s.cwd,
      status: s.status,
      superseded: s.superseded,
      polling: s.polling,
    }));
  }
}
