// The capabilities pass in the web view (W): the agent registry, a person's
// inbox, reminders and alerts. Every list is a live Convex subscription; the
// logic is in lib/view.ts.

import type { Alert, Reminder, ReminderAction, RegistryEntry } from "@agent-comms/protocol";
import { useMutation, useQuery } from "convex/react";
import { type FormEvent, type ReactNode, useEffect, useState } from "react";
import { api } from "../../../convex/_generated/api";
import {
  ACTION_LABEL,
  alertConfigForm,
  alertLabel,
  clockTime,
  inboxKind,
  liveStale,
  parseAlertConfig,
  parseProfile,
  parseReminderForm,
  presenceView,
  type ReminderForm,
  endedRemindersSummary,
  reminderActions,
  reminderLast,
  reminderLine,
  scheduleText,
} from "./lib/view.ts";

// ---------------------------------------------------------------------------
// Agent registry

type DirectoryData = NonNullable<ReturnType<typeof useQuery<typeof api.directory.list>>>;

export function Registry({ token, directory, now, promote }: { token: string; directory: DirectoryData; now: number; promote: ReactNode }) {
  const registry = useQuery(api.registry.list, { adminToken: token });
  const setState = useMutation(api.directory.setState);
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const machineSeen = new Map(directory.machines.map((m) => [m.machineId, m.lastSeenAt ?? null]));

  const act = (name: string, state: "active" | "paused" | "retired") => {
    if (state === "retired" && !confirm(`Retire @${name}? It gets no more deliveries, and this can't be undone.`)) return;
    setState({ adminToken: token, name, state }).catch((e: Error) => setError(e.message));
  };

  if (!registry) return <p className="muted">Loading…</p>;
  const groups: [string, RegistryEntry[]][] = [
    ["Agents", registry.agents.filter((e) => e.participant.kind === "agent" && e.state !== "retired")],
    ["People", registry.agents.filter((e) => e.participant.kind === "human")],
    ["System", registry.agents.filter((e) => e.participant.kind === "system")],
    ["Retired", registry.agents.filter((e) => e.participant.kind === "agent" && e.state === "retired")],
  ];

  return (
    <>
      <h2>Agent registry</h2>
      {error && <p className="error">{error}</p>}
      {groups.map(([label, rows]) =>
        rows.length === 0 ? null : (
          <Group key={label} label={label} count={rows.length} collapsed={label === "Retired"}>
            <ul className="people registry">
              {rows.map((raw) => {
                const e = liveStale(raw, raw.home ? machineSeen.get(raw.home.machine) ?? null : null, now);
                const p = e.participant;
                const { status, label: presence } = presenceView(e, now);
                const showPresence = status === "stale" || status === "unconnected" || status === "offline" || status === "idle";
                return (
                  <li key={p.id} className={`state-${e.state}`} data-name={p.name}>
                    <span className={`dot ${status}`} title={presence} />
                    <span className="name">@{p.name}</span>
                    <span className="muted small">
                      {e.home ? `${e.home.harness} · ${e.home.machine}` : p.kind === "system" ? "system" : "web"}
                      {e.owner && ` · owner @${e.owner.name}`}
                      {e.state !== "active" && ` · ${e.state}`}
                      {p.kind === "agent" && showPresence && ` · ${presence}`}
                    </span>
                    {p.kind === "agent" && e.state !== "retired" && (
                      <span className="actions">
                        <button onClick={() => setEditing(editing === p.name ? null : p.name)}>{editing === p.name ? "Close" : "Edit"}</button>
                        {e.state === "active" ? <button onClick={() => act(p.name, "paused")}>Pause</button> : <button onClick={() => act(p.name, "active")}>Resume</button>}
                        <button className="danger" onClick={() => act(p.name, "retired")}>Retire</button>
                      </span>
                    )}
                    {editing === p.name ? (
                      <ProfileEditor token={token} entry={e} onDone={() => setEditing(null)} />
                    ) : (
                      (e.description || (e.duties && e.duties.length > 0)) && (
                        <div className="profile small">
                          {e.description && <div className="description">{e.description}</div>}
                          {e.duties && e.duties.length > 0 && (
                            <ul className="duties">
                              {e.duties.map((d, i) => (
                                <li key={i}>{d}</li>
                              ))}
                            </ul>
                          )}
                        </div>
                      )
                    )}
                  </li>
                );
              })}
            </ul>
          </Group>
        ),
      )}
      {promote}
    </>
  );
}

function Group({ label, count, collapsed, children }: { label: string; count: number; collapsed: boolean; children: ReactNode }) {
  if (label === "Agents") return <div>{children}</div>;
  if (collapsed)
    return (
      <details className="group">
        <summary className="small muted">
          {count} {label.toLowerCase()}
        </summary>
        {children}
      </details>
    );
  return (
    <div>
      <h3 className="group">{label}</h3>
      {children}
    </div>
  );
}

function ProfileEditor({ token, entry, onDone }: { token: string; entry: RegistryEntry; onDone: () => void }) {
  const setProfile = useMutation(api.registry.setProfile);
  const [description, setDescription] = useState(entry.description ?? "");
  const [duties, setDuties] = useState((entry.duties ?? []).join("\n"));
  const [error, setError] = useState<string | null>(null);
  const save = (e: FormEvent) => {
    e.preventDefault();
    const parsed = parseProfile(description, duties);
    if (!parsed.ok) return setError(parsed.error);
    setProfile({ adminToken: token, name: entry.participant.name, ...parsed.value })
      .then(onDone)
      .catch((err: Error) => setError(err.message));
  };
  return (
    <form className="profile-edit" onSubmit={save}>
      <label>
        Description (one line)
        <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What this agent is for" />
      </label>
      <label>
        Duties (one per line)
        <textarea rows={4} value={duties} onChange={(e) => setDuties(e.target.value)} />
      </label>
      <button type="submit">Save</button>
      {error && <p className="error">{error}</p>}
    </form>
  );
}

// ---------------------------------------------------------------------------
// Inbox

export function Inbox({ token, human, onOpen }: { token: string; human: string; onOpen: (conversationId: string) => void }) {
  // Pages of older items, by the opaque `nextCursor` each page returns (fix pass 2, follow-up 5):
  // nothing unread is out of reach, whatever the count, even when items share a timestamp.
  const [cursors, setCursors] = useState<string[]>([]);
  const [unreadOnly, setUnreadOnly] = useState(false);
  const cursor = cursors.at(-1);
  const inbox = useQuery(api.inbox.list, { adminToken: token, human, limit: 100, ...(unreadOnly ? { unreadOnly } : {}), ...(cursor !== undefined ? { cursor } : {}) });
  const markRead = useMutation(api.inbox.markRead);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setCursors([]), [human, unreadOnly]);
  if (!inbox) return <p className="muted">Loading…</p>;
  const open = (conversationId: string, messageId: string, unread: boolean) => {
    if (unread) markRead({ adminToken: token, human, messageIds: [messageId] }).catch((e: Error) => setError(e.message));
    onOpen(conversationId);
  };
  return (
    <>
      <h2>
        Inbox for @{human} <span className="muted small">{inbox.unread} unread</span>
      </h2>
      {error && <p className="error">{error}</p>}
      <div className="inbox-tools small">
        <label className="check">
          <input type="checkbox" checked={unreadOnly} onChange={(e) => setUnreadOnly(e.target.checked)} /> Unread only
        </label>
        {inbox.unread > 0 && (
          // Every unread item, not only those on this page.
          <button onClick={() => markRead({ adminToken: token, human, all: true }).catch((e: Error) => setError(e.message))}>Mark all read</button>
        )}
      </div>
      <ul className="inbox">
        {inbox.items.map(({ message: m, conversation: c, readAt }) => {
          const kind = inboxKind(m);
          return (
            <li key={m.id} className={readAt === null ? "unread" : ""} data-message={m.id} onClick={() => open(c.id, m.id, readAt === null)}>
              <span className="small">
                <strong>@{m.sender.name}</strong>
                {kind && <span className={`tag ${m.meta?.type ?? ""}`}>{kind}</span>}
                <span className="muted"> · {c.kind === "group" ? c.title : "DM"} · {clockTime(m.createdAt)}</span>
              </span>
              <span className="head">{m.text.length > 160 ? `${m.text.slice(0, 160)}…` : m.text}</span>
            </li>
          );
        })}
        {inbox.items.length === 0 && <li className="muted">{unreadOnly ? "Nothing unread." : `Nothing addressed to @${human} yet.`}</li>}
      </ul>
      <div className="pager small">
        {cursors.length > 0 && <button onClick={() => setCursors(cursors.slice(0, -1))}>Newer</button>}
        {inbox.hasMore && inbox.nextCursor !== undefined && <button onClick={() => setCursors([...cursors, inbox.nextCursor!])}>Older</button>}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Reminders

const EMPTY_FORM: ReminderForm = { target: "", text: "", every: "", at: "", name: "", idleFor: "", watch: "", max: "", reportTo: "", expires: "" };

export function Reminders({ token, as, now }: { token: string; as: string; now: number }) {
  const list = useQuery(api.reminders.list, { adminToken: token });
  const update = useMutation(api.reminders.update);
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!list) return <p className="muted">Loading…</p>;

  const act = (r: Reminder, action: ReminderAction) => {
    let reason: string | undefined;
    if (action === "blocked") {
      reason = prompt(`Why is "${r.name}" blocked? It stops firing until resumed.`)?.trim();
      if (!reason) return;
    }
    if (action === "cancel" && !confirm(`Cancel reminder "${r.name}"? It won't fire again. A turn already running from it finishes.`)) return;
    update({ adminToken: token, id: r.id, action, ...(reason ? { reason } : {}) }).catch((e: Error) => setError(e.message));
  };

  const live = list.reminders.filter((r) => r.state === "active" || r.state === "paused" || r.state === "blocked");
  const ended = list.reminders.filter((r) => !live.includes(r));
  const row = (r: Reminder) => (
    <li key={r.id} className={`reminder state-${r.state}`} data-reminder={r.id}>
      <div>
        <strong>{r.name}</strong> <span className="muted">→ @{r.target.name}</span>
        <span className={`badge r-${r.state}`}>{r.state}</span>
      </div>
      <div className="small">{scheduleText(r)}</div>
      <div className="small muted">
        {reminderLine(r, now)} · set by @{r.createdBy.name}
        {r.reportTo && ` · reports to @${r.reportTo.name}`} · expires {clockTime(r.expiresAt)}
      </div>
      {reminderLast(r, now) && <div className="small muted last">{reminderLast(r, now)}</div>}
      <div className="text small">{r.text}</div>
      <div className="actions">
        {reminderActions(r.state).map((a) => (
          <button key={a} className={a === "cancel" ? "danger" : ""} onClick={() => act(r, a)}>
            {ACTION_LABEL[a]}
          </button>
        ))}
        <button onClick={() => setOpen(open === r.id ? null : r.id)}>{open === r.id ? "Hide history" : "History"}</button>
      </div>
      {open === r.id && <ReminderHistory token={token} id={r.id} />}
    </li>
  );

  return (
    <>
      <h2>Reminders</h2>
      {error && <p className="error">{error}</p>}
      <ul className="reminders">
        {live.map(row)}
        {live.length === 0 && <li className="muted">No live reminders.</li>}
      </ul>
      {ended.length > 0 && (
        <details>
          <summary className="small muted">{endedRemindersSummary(ended.length)}</summary>
          <ul className="reminders">{ended.map(row)}</ul>
        </details>
      )}
      <NewReminder token={token} as={as} />
    </>
  );
}

function ReminderHistory({ token, id }: { token: string; id: string }) {
  const detail = useQuery(api.reminders.get, { adminToken: token, id });
  if (!detail) return <p className="muted small">Loading…</p>;
  const events = [
    ...detail.fires.map((f) => ({ at: f.firedAt, key: `f${f.messageId}`, node: (
      <>
        fire → <span className={`badge ${f.deliveryState}`}>{f.deliveryState}</span>
        {f.answer && <div className="text">{f.answer.text.length > 300 ? `${f.answer.text.slice(0, 300)}…` : f.answer.text}</div>}
      </>
    ) })),
    ...detail.skips.map((s, i) => ({ at: s.at, key: `s${i}`, node: <span className="muted">skipped: {s.reason.replace(/-/g, " ")}{s.detail ? ` (${s.detail})` : ""}</span> })),
  ].sort((a, b) => b.at - a.at);
  return (
    <ol className="history small">
      {events.map((e) => (
        <li key={e.key}>
          <span className="muted">{clockTime(e.at)}</span> {e.node}
        </li>
      ))}
      {events.length === 0 && <li className="muted">Not fired yet.</li>}
    </ol>
  );
}

function NewReminder({ token, as }: { token: string; as: string }) {
  const create = useMutation(api.reminders.create);
  const [form, setForm] = useState<ReminderForm>(EMPTY_FORM);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const field = (key: keyof ReminderForm) => ({ value: form[key], onChange: (e: { target: { value: string } }) => setForm({ ...form, [key]: e.target.value }) });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const parsed = parseReminderForm(form, Date.now());
    if (!parsed.ok) return setNote({ ok: false, text: parsed.error });
    create({ adminToken: token, as, ...parsed.value })
      .then((r) => {
        setNote({ ok: true, text: `Reminder "${r.reminder.name}" set for @${r.reminder.target.name}.` });
        setForm(EMPTY_FORM);
      })
      .catch((err: Error) => setNote({ ok: false, text: err.message }));
  };
  return (
    <form className="card" onSubmit={submit}>
      <h3>New reminder, as @{as}</h3>
      <label>
        For <input {...field("target")} placeholder="@reed" />
      </label>
      <label>
        Asks <textarea rows={2} {...field("text")} />
      </label>
      <div className="row">
        <label>
          Every <input {...field("every")} placeholder="30m" />
        </label>
        <label>
          or once at <input type="datetime-local" {...field("at")} />
        </label>
      </div>
      <details>
        <summary className="small muted">Options</summary>
        <label>
          Name <input {...field("name")} placeholder="ci" />
        </label>
        <div className="row">
          <label>
            Only once idle for <input {...field("idleFor")} placeholder="20m" />
          </label>
          <label>
            Watching <input {...field("watch")} placeholder="@hazel (default: the target)" />
          </label>
        </div>
        <div className="row">
          <label>
            At most <input {...field("max")} placeholder="fires" />
          </label>
          <label>
            Report to <input {...field("reportTo")} placeholder="@lee" />
          </label>
          <label>
            Expires after <input {...field("expires")} placeholder="7d" />
          </label>
        </div>
      </details>
      <button type="submit">Set reminder</button>
      {note && <p className={note.ok ? "ok" : "error"}>{note.text}</p>}
    </form>
  );
}

// ---------------------------------------------------------------------------
// Alerts

/** Open incidents (all of them, from their own query) and the recent resolved ones. */
export function Alerts(props: { token: string; open: Alert[] | undefined; resolved: Alert[]; now: number; onOpen: (conversationId: string) => void }) {
  const { token, open, resolved, now, onOpen } = props;
  if (!open) return <p className="muted">Loading…</p>;
  const row = (a: Alert) => (
    <li key={a.id} className={a.resolvedAt === undefined ? "open" : "resolved"} data-alert={a.id}>
      <div>
        <strong>{alertLabel(a, now)}</strong>
      </div>
      <div className="small">{a.summary}</div>
      <div className="small muted">
        to @{a.owner.name} · opened {clockTime(a.openedAt)}
        {a.resolvedAt !== undefined && ` · resolved ${clockTime(a.resolvedAt)}`}
      </div>
      <div className="actions">
        <button onClick={() => onOpen(a.conversationId)}>Open alert</button>
        {a.subject.conversationId && <button onClick={() => onOpen(a.subject.conversationId!)}>Open the delivery's conversation</button>}
      </div>
    </li>
  );
  return (
    <>
      <h2>Alerts</h2>
      <ul className="alerts">
        {open.map(row)}
        {open.length === 0 && <li className="muted">No open alerts.</li>}
      </ul>
      {resolved.length > 0 && (
        <details>
          <summary className="small muted">{resolved.length} resolved</summary>
          <ul className="alerts">{resolved.map(row)}</ul>
        </details>
      )}
      <AlertSettings token={token} />
    </>
  );
}

function AlertSettings({ token }: { token: string }) {
  const config = useQuery(api.alerts.config, { adminToken: token });
  const setConfig = useMutation(api.alerts.setConfig);
  const [form, setForm] = useState<ReturnType<typeof alertConfigForm> | null>(null);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => {
    if (config && !form) setForm(alertConfigForm(config));
  }, [config, form]);
  if (!form) return null;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const parsed = parseAlertConfig(form);
    if (!parsed.ok) return setNote({ ok: false, text: parsed.error });
    setConfig({ adminToken: token, ...parsed.value })
      .then((c) => (setForm(alertConfigForm(c)), setNote({ ok: true, text: "Saved." })))
      .catch((err: Error) => setNote({ ok: false, text: err.message }));
  };
  return (
    <form className="card" onSubmit={submit}>
      <h3>Alert thresholds</h3>
      <label>
        Connector silent for (minutes) <input value={form.connectorSilentMin} onChange={(e) => setForm({ ...form, connectorSilentMin: e.target.value })} />
      </label>
      <label>
        Reminder blocked for (minutes) <input value={form.reminderBlockedMin} onChange={(e) => setForm({ ...form, reminderBlockedMin: e.target.value })} />
      </label>
      <label>
        Delivery claimed more than (times) <input value={form.maxClaims} onChange={(e) => setForm({ ...form, maxClaims: e.target.value })} />
      </label>
      <button type="submit">Save</button>
      {note && <p className={note.ok ? "ok" : "error"}>{note.text}</p>}
    </form>
  );
}
