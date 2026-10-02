// The web view's logic for the capabilities pass (W): the agent registry,
// reminders, the inbox and alerts. Pure, so it's tested without a browser
// (test/view.test.ts); the components in App.tsx only wire it to Convex.

import {
  type Alert,
  type AlertCause,
  type AlertConfig,
  formatDuration,
  formatSchedule,
  MAX_DESCRIPTION_CHARS,
  MAX_DUTIES,
  MAX_DUTY_CHARS,
  MAX_TEXT_CHARS,
  NAME_PATTERN,
  parseDuration,
  REMINDER_DEFAULT_EXPIRY_MS,
  REMINDER_MAX_EXPIRY_MS,
  REMINDER_MIN_INTERVAL_MS,
  type Reminder,
  type ReminderAction,
  type MessageEnvelope,
  PRESENCE_STALE_MS,
  type ReminderState,
  RESERVED_NAMES,
  type RegistryEntry,
} from "@agent-comms/protocol";

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** A span for people: "45s", "12m", "3h 5m", "2d 4h". */
export function span(ms: number): string {
  const t = Math.max(0, ms);
  if (t < MINUTE) return `${Math.floor(t / 1000)}s`;
  if (t < HOUR) return `${Math.floor(t / MINUTE)}m`;
  if (t < DAY) {
    const m = Math.floor((t % HOUR) / MINUTE);
    return `${Math.floor(t / HOUR)}h${m ? ` ${m}m` : ""}`;
  }
  const h = Math.floor((t % DAY) / HOUR);
  return `${Math.floor(t / DAY)}d${h ? ` ${h}h` : ""}`;
}

export function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

export function clockTime(ms: number): string {
  const d = new Date(ms);
  const today = new Date().toDateString() === d.toDateString();
  return today ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : d.toLocaleString([], { dateStyle: "short", timeStyle: "short" });
}

// ---------------------------------------------------------------------------
// Registry

export type PresenceStatus = "person" | "system" | "stale" | "unconnected" | "offline" | "idle" | "busy";

/**
 * What the registry shows for a participant. A stale machine's presence can't be
 * trusted, so it's never shown as idle (the same rule reminders use for --idle-for).
 */
export function presenceView(e: RegistryEntry, now: number): { status: PresenceStatus; label: string } {
  const p = e.presence;
  if (!p) return e.participant.kind === "system" ? { status: "system", label: "system" } : { status: "person", label: "person" };
  if (p.stale) return { status: "stale", label: `connector not heard from (last update ${clockTime(p.at)})` };
  if (p.status === "offline") {
    return e.harness === "claude-code"
      ? { status: "unconnected", label: "mod not connected" }
      : { status: "offline", label: "offline (T3 or its thread unreachable)" };
  }
  if (p.status === "busy") return { status: "busy", label: "busy" };
  return { status: "idle", label: p.idleSince !== undefined ? `idle for ${span(now - p.idleSince)}` : "idle" };
}

/**
 * A Convex query's clock stops between writes, so `presence.stale` from
 * `registry.list` can be out of date. The view re-derives it from the machine's
 * last heartbeat (`directory.list`) on its own clock.
 */
export function liveStale(e: RegistryEntry, machineSeen: number | null, now: number): RegistryEntry {
  if (!e.presence) return e;
  const stale = e.presence.stale || machineSeen === null || now - machineSeen >= PRESENCE_STALE_MS;
  return stale === e.presence.stale ? e : { ...e, presence: { ...e.presence, stale } };
}

export interface PromotionForm {
  name: string;
  harness: "t3" | "claude-code";
  machine: string;
  /** The T3 thread id; ignored for a Claude Code terminal (its locator is its name). */
  locator: string;
  /** A person's name. */
  owner: string;
}

/** The promote form as `directory.promote` arguments (R1: an agent needs an owner; reserved names are refused). */
export function parsePromotion(
  f: PromotionForm,
  people: readonly string[],
): Parsed<{ name: string; kind: "agent"; home: { machine: string; harness: "t3" | "claude-code"; locator: string }; owner: string }> {
  if (!NAME_PATTERN.test(f.name)) return { ok: false, error: "Names are lowercase letters, digits, - and _." };
  if (RESERVED_NAMES.includes(f.name)) return { ok: false, error: `@${f.name} is reserved.` };
  const machine = f.machine.trim();
  if (!machine) return { ok: false, error: "Give the machine it lives on." };
  const locator = f.harness === "claude-code" ? f.name : f.locator.trim();
  if (!locator) return { ok: false, error: "Give the T3 thread id." };
  if (!people.includes(f.owner)) return { ok: false, error: "Pick its owner (a person)." };
  return { ok: true, value: { name: f.name, kind: "agent", home: { machine, harness: f.harness, locator }, owner: f.owner } };
}

/** The profile editor: one description line, one duty per line (blank lines dropped). Empty clears. */
export function parseProfile(description: string, dutiesText: string): Parsed<{ description: string; duties: string[] }> {
  const d = description.trim();
  if (/[\r\n]/.test(d)) return { ok: false, error: "The description is one line." };
  if (d.length > MAX_DESCRIPTION_CHARS) return { ok: false, error: `The description is at most ${MAX_DESCRIPTION_CHARS} characters.` };
  const duties = dutiesText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (duties.length > MAX_DUTIES) return { ok: false, error: `At most ${MAX_DUTIES} duties.` };
  if (duties.some((l) => l.length > MAX_DUTY_CHARS)) return { ok: false, error: `Each duty is at most ${MAX_DUTY_CHARS} characters.` };
  return { ok: true, value: { description: d, duties } };
}

// ---------------------------------------------------------------------------
// Reminders

const ACTIONS: Record<ReminderState, ReminderAction[]> = {
  active: ["pause", "blocked", "done", "cancel"],
  paused: ["resume", "done", "cancel"],
  blocked: ["resume", "done", "cancel"],
  done: [],
  cancelled: [],
  expired: [],
};

/** The controls a reminder in this state offers. Only `active` fires; ended reminders take no action. */
export function reminderActions(state: ReminderState): ReminderAction[] {
  return ACTIONS[state];
}

export const ACTION_LABEL: Record<ReminderAction, string> = {
  pause: "Pause",
  resume: "Resume",
  blocked: "Blocked…",
  done: "Done",
  cancel: "Cancel",
};

/** "every 30m", "once at 14:30", plus its idle condition and fire limit. */
export function scheduleText(r: Reminder): string {
  // The same words as the fire's "Reminder:" line (formatSchedule).
  const parts = [formatSchedule(r.schedule)];
  if (r.idleForMs !== undefined && r.idleForMs > 0) parts.push(`once @${(r.watch ?? r.target).name} has been idle ${formatDuration(r.idleForMs)}`);
  if (r.max !== undefined) parts.push(`at most ${plural(r.max, "fire")}`);
  return parts.join(", ");
}

/** "active · 2 of 3 fires · next in 5m", "blocked: waiting on Lee · 2 fires". */
export function reminderLine(r: Reminder, now: number): string {
  const state = r.stateReason && r.state !== "active" ? `${r.state}: ${r.stateReason}` : r.state;
  const fires = r.max !== undefined ? `${r.fires} of ${plural(r.max, "fire")}` : plural(r.fires, "fire");
  const parts = [state, fires];
  if (r.state === "active" && r.nextFireAt !== undefined) parts.push(r.nextFireAt > now ? `next in ${span(r.nextFireAt - now)}` : "due now");
  return parts.join(" · ");
}

/**
 * The last thing that happened, for the list: the last fire's delivery state, or
 * the last skip if it's newer (with the fire it was waiting on). Null if neither.
 */
export function reminderLast(r: Reminder, now: number): string | null {
  const fire = r.lastFire ? `last fire ${span(now - r.lastFire.firedAt)} ago: ${r.lastFire.deliveryState}` : null;
  const skip = r.lastSkip;
  if (skip && (!r.lastFire || skip.at > r.lastFire.firedAt)) {
    const why = `${skip.reason.replace(/-/g, " ")}${skip.detail ? `, ${skip.detail}` : ""}`;
    return `skipped ${span(now - skip.at)} ago: ${why}${fire ? ` (${fire})` : ""}`;
  }
  return fire;
}

export interface ReminderForm {
  target: string;
  text: string;
  every: string;
  /** A `datetime-local` value (local time) or any string Date.parse reads. */
  at: string;
  name: string;
  idleFor: string;
  watch: string;
  max: string;
  reportTo: string;
  expires: string;
}

export interface ReminderArgs {
  target: string;
  text: string;
  everyMs?: number;
  at?: number;
  name?: string;
  idleForMs?: number;
  watch?: string;
  max?: number;
  reportTo?: string;
  expiresMs?: number;
}

function nameField(value: string, label: string): Parsed<string | undefined> {
  const n = value.trim().replace(/^@/, "");
  if (!n) return { ok: true, value: undefined };
  return NAME_PATTERN.test(n) ? { ok: true, value: n } : { ok: false, error: `${label}: not a participant name.` };
}

function durationField(value: string, label: string): Parsed<number | undefined> {
  const v = value.trim();
  if (!v) return { ok: true, value: undefined };
  const ms = parseDuration(v);
  return ms === null ? { ok: false, error: `${label}: a duration like 90s, 20m, 2h or 7d.` } : { ok: true, value: ms };
}

/** The create form as `reminders.create` arguments, refusing what Convex would refuse. */
export function parseReminderForm(f: ReminderForm, now: number): Parsed<ReminderArgs> {
  const target = nameField(f.target, "Target");
  if (!target.ok) return target;
  if (!target.value) return { ok: false, error: "Give the target, e.g. @reed." };
  const text = f.text.trim();
  if (!text) return { ok: false, error: "Say what the reminder asks." };
  if (text.length > MAX_TEXT_CHARS) return { ok: false, error: `The reminder's text is at most ${MAX_TEXT_CHARS.toLocaleString()} characters.` };
  const out: ReminderArgs = { target: target.value, text };

  const every = durationField(f.every, "Every");
  if (!every.ok) return every;
  const hasAt = f.at.trim().length > 0;
  if ((every.value === undefined) === !hasAt) return { ok: false, error: "Give exactly one of Every and At." };
  const expires = durationField(f.expires, "Expires");
  if (!expires.ok) return expires;
  if (expires.value !== undefined && (expires.value < REMINDER_MIN_INTERVAL_MS || expires.value > REMINDER_MAX_EXPIRY_MS)) {
    return { ok: false, error: "Expires: between 1 minute and 30 days." };
  }
  if (every.value !== undefined) {
    if (every.value < REMINDER_MIN_INTERVAL_MS) return { ok: false, error: "Every: at least 1m (reminders fire from a once-a-minute cron)." };
    if (every.value > REMINDER_MAX_EXPIRY_MS) return { ok: false, error: "Every: at most 30d." };
    out.everyMs = every.value;
  } else {
    const at = Date.parse(f.at.trim());
    if (Number.isNaN(at)) return { ok: false, error: "At: not a date and time." };
    if (at <= now) return { ok: false, error: "At: must be in the future." };
    if (at > now + (expires.value ?? REMINDER_DEFAULT_EXPIRY_MS)) return { ok: false, error: "At: must be before the reminder expires." };
    out.at = at;
  }
  const name = f.name.trim();
  if (name) {
    if (name.length > 80) return { ok: false, error: "Name: at most 80 characters." };
    // One line: a name is rendered into the fire's header block.
    if (/[\u0000-\u001f\u007f]/.test(name)) return { ok: false, error: "Name: one line, no control characters." };
    out.name = name;
  }
  const idle = durationField(f.idleFor, "Idle for");
  if (!idle.ok) return idle;
  if (idle.value !== undefined) out.idleForMs = idle.value;
  const watch = nameField(f.watch, "Watch");
  if (!watch.ok) return watch;
  if (watch.value) out.watch = watch.value;
  if (f.max.trim()) {
    const max = Number(f.max.trim());
    if (!Number.isInteger(max) || max < 1 || max > 10_000) return { ok: false, error: "Max: a whole number of fires, 1 or more." };
    out.max = max;
  }
  const reportTo = nameField(f.reportTo, "Report to");
  if (!reportTo.ok) return reportTo;
  if (reportTo.value) out.reportTo = reportTo.value;
  if (expires.value !== undefined) out.expiresMs = expires.value;
  return { ok: true, value: out };
}

// ---------------------------------------------------------------------------
// Inbox

export function inboxBadge(unread: number): string {
  return unread > 0 ? `Inbox (${unread})` : "Inbox";
}

/** What a system participant's message is, for the inbox list; null for anyone else's. */
export function inboxKind(m: Pick<MessageEnvelope, "meta">): string | null {
  const meta = m.meta;
  if (!meta) return null;
  switch (meta.type) {
    case "alert":
      return "Alert";
    case "reminder":
      return `Reminder: ${meta.name}`;
    case "reminder-report":
      return `Reminder report: ${meta.name}`;
    case "reminder-ended":
      return `Reminder ended: ${meta.name}`;
  }
}

export function titleWithUnread(title: string, unread: number): string {
  return unread > 0 ? `(${unread}) ${title}` : title;
}

// ---------------------------------------------------------------------------
// Alerts

export const ALERT_CAUSE_LABEL: Record<AlertCause, string> = {
  "uncertain-delivery": "Uncertain delivery",
  "connector-silent": "Connector silent",
  "reminder-blocked": "Reminder blocked",
  "reminder-expired": "Reminder expired",
  "delivery-reclaimed": "Delivery reclaimed repeatedly",
};

/** "Uncertain delivery · d_9 · open 5m", "Connector silent · lim-builder · resolved after 4m". */
export function alertLabel(a: Alert, now: number): string {
  const age = a.resolvedAt !== undefined ? `resolved after ${span(a.resolvedAt - a.openedAt)}` : `open ${span(now - a.openedAt)}`;
  return `${ALERT_CAUSE_LABEL[a.cause] ?? a.cause} · ${a.subject.id} · ${age}`;
}

export function alertsBadge(alerts: readonly Alert[]): string {
  const open = alerts.filter((a) => a.resolvedAt === undefined).length;
  return open > 0 ? `Alerts (${open})` : "Alerts";
}

export interface AlertConfigForm {
  connectorSilentMin: string;
  reminderBlockedMin: string;
  maxClaims: string;
}

export function alertConfigForm(c: AlertConfig): AlertConfigForm {
  return { connectorSilentMin: String(c.connectorSilentMs / MINUTE), reminderBlockedMin: String(c.reminderBlockedMs / MINUTE), maxClaims: String(c.maxClaims) };
}

/** The thresholds form, checked against the ranges `alerts.setConfig` enforces. */
/** A whole number typed into a form, or NaN (blank, a fraction, "Infinity", anything else). */
function wholeNumber(text: string): number {
  return /^\s*\d+\s*$/.test(text) ? Number(text) : Number.NaN;
}

export function parseAlertConfig(f: AlertConfigForm): Parsed<AlertConfig> {
  // Finite whole numbers first, then the ranges `alerts.setConfig` enforces.
  const silent = wholeNumber(f.connectorSilentMin);
  const blocked = wholeNumber(f.reminderBlockedMin);
  const claims = wholeNumber(f.maxClaims);
  if (!Number.isFinite(silent) || silent < 2 || silent > 7 * 24 * 60) return { ok: false, error: "Connector silent: 2 minutes to 7 days (in minutes)." };
  if (!Number.isFinite(blocked) || blocked < 1 || blocked > 30 * 24 * 60) return { ok: false, error: "Reminder blocked: 1 minute to 30 days (in minutes)." };
  if (!Number.isInteger(claims) || claims < 2 || claims > 100) return { ok: false, error: "Max claims: a whole number from 2 to 100." };
  return { ok: true, value: { connectorSilentMs: Math.round(silent * MINUTE), reminderBlockedMs: Math.round(blocked * MINUTE), maxClaims: claims } };
}

/** The people an agent can be owned by: active people (a retired person can't own an agent). */
export function ownerChoices(participants: readonly { name: string; kind: string; state: string }[]): string[] {
  return participants.filter((p) => p.kind === "human" && p.state === "active").map((p) => p.name);
}

/** The Alerts tab's badge, open list and resolved list (today's behaviour: all from the newest alerts). */
export function alertsView(open: readonly Alert[] | undefined, recent: readonly Alert[] | undefined): { badge: string; open: Alert[]; resolved: Alert[] } {
  const r = recent ?? [];
  return { badge: alertsBadge(r), open: r.filter((a) => a.resolvedAt === undefined), resolved: r.filter((a) => a.resolvedAt !== undefined) };
}

/** Who the view posts as by default (today's behaviour: the saved choice, else "lee"). */
export function defaultPostingAs(saved: string | null, participants: readonly { name: string; kind: string; state: string }[]): string {
  return saved ?? "lee";
}
