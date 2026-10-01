// Lee's view onto the comms server. Plain on purpose: a side pane (the agent
// registry, the inbox, reminders, alerts), conversations, one conversation with
// its delivery states, and a composer. Everything is a live Convex subscription;
// the dev admin token is kept in localStorage.

import { useMutation, useQuery } from "convex/react";
import { Component, type FormEvent, type ReactNode, useEffect, useMemo, useState } from "react";
import { api } from "../../../convex/_generated/api";
import { Alerts, Inbox, Registry, Reminders } from "./Capabilities.tsx";
import { alertsBadge, inboxBadge, parsePromotion, titleWithUnread } from "./lib/view.ts";

const TOKEN_KEY = "agent-comms.adminToken";
const AS_KEY = "agent-comms.as";

export function App() {
  const [token, setToken] = useState(() => localStorage.getItem(TOKEN_KEY) || __DEV_ADMIN_TOKEN__);
  if (!token) return <TokenGate onToken={(t) => (localStorage.setItem(TOKEN_KEY, t), setToken(t))} />;
  return (
    <Boundary onReset={() => (localStorage.removeItem(TOKEN_KEY), setToken(""))}>
      <Main token={token} />
    </Boundary>
  );
}

function TokenGate({ onToken }: { onToken: (t: string) => void }) {
  const [value, setValue] = useState("");
  return (
    <form className="gate" onSubmit={(e) => (e.preventDefault(), value.trim() && onToken(value.trim()))}>
      <h1>agent comms</h1>
      <label>
        Admin token
        <input type="password" value={value} onChange={(e) => setValue(e.target.value)} autoFocus />
      </label>
      <button type="submit">Open</button>
    </form>
  );
}

class Boundary extends Component<{ children: ReactNode; onReset: () => void }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="gate">
        <p className="error">{this.state.error.message.includes("admin token") ? "That admin token was rejected." : this.state.error.message}</p>
        <button onClick={() => (this.setState({ error: null }), this.props.onReset())}>Enter the token again</button>
      </div>
    );
  }
}

type Side = "agents" | "inbox" | "reminders" | "alerts";
type Tab = "side" | "conversations" | "conversation";

function Main({ token }: { token: string }) {
  const directory = useQuery(api.directory.list, { adminToken: token });
  const conversations = useQuery(api.conversations.list, { adminToken: token });
  const alerts = useQuery(api.alerts.list, { adminToken: token, limit: 100 });
  const [selected, setSelected] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("conversations");
  const [side, setSide] = useState<Side>("agents");
  const people = directory?.participants.filter((p) => p.kind === "human") ?? [];
  const [as, setAs] = useState(() => localStorage.getItem(AS_KEY) ?? "lee");
  useEffect(() => localStorage.setItem(AS_KEY, as), [as]);
  const isPerson = people.some((p) => p.name === as);
  const unread = useQuery(api.inbox.list, isPerson ? { adminToken: token, human: as, unreadOnly: true, limit: 200 } : "skip");
  const unreadCount = unread?.unread ?? 0;
  const unreadConversations = useMemo(() => new Set(unread?.items.map((i) => i.conversation.id) ?? []), [unread]);
  const now = useNow(15_000);
  useEffect(() => {
    document.title = titleWithUnread("agent comms", unreadCount);
  }, [unreadCount]);

  const open = (id: string) => {
    setSelected(id);
    setTab("conversation");
  };
  const showSide = (s: Side) => {
    setSide(s);
    setTab("side");
  };
  const sideTabs: [Side, string][] = [
    ["agents", "Agents"],
    ["inbox", inboxBadge(unreadCount)],
    ["reminders", "Reminders"],
    ["alerts", alertsBadge(alerts?.alerts ?? [])],
  ];

  return (
    <div className="app" data-tab={tab}>
      <header>
        <strong>agent comms</strong>
        <nav>
          {sideTabs.map(([s, label]) => (
            <button key={s} className={tab === "side" && side === s ? "on" : ""} onClick={() => showSide(s)}>
              {label}
            </button>
          ))}
          <button className={tab === "conversations" ? "on" : ""} onClick={() => setTab("conversations")}>Conversations</button>
          {selected && <button className={tab === "conversation" ? "on" : ""} onClick={() => setTab("conversation")}>Open</button>}
        </nav>
        {unreadCount > 0 && (
          <button className="unread-pill" onClick={() => showSide("inbox")} title={`@${as} has ${unreadCount} unread`}>
            {unreadCount} unread
          </button>
        )}
        <label className="as">
          posting as
          <select value={as} onChange={(e) => setAs(e.target.value)}>
            {people.length === 0 && <option value={as}>@{as}</option>}
            {people.map((p) => <option key={p.id} value={p.name}>@{p.name}</option>)}
          </select>
        </label>
      </header>
      <section className="pane side" data-side={side}>
        <div className="side-tabs">
          {sideTabs.map(([s, label]) => (
            <button key={s} className={side === s ? "on" : ""} onClick={() => setSide(s)}>
              {label}
            </button>
          ))}
        </div>
        {side === "agents" &&
          (directory ? <Registry token={token} directory={directory} now={now} promote={<Promote token={token} machines={directory.machines.map((m) => m.machineId)} people={people.map((p) => p.name)} />} /> : <p className="muted">Loading…</p>)}
        {side === "inbox" && (isPerson ? <Inbox token={token} human={as} onOpen={open} /> : <p className="muted">Pick a person to post as; the inbox is theirs.</p>)}
        {side === "reminders" && <Reminders token={token} as={as} now={now} />}
        {side === "alerts" && <Alerts token={token} alerts={alerts?.alerts} now={now} onOpen={open} />}
      </section>
      <section className="pane conversations">
        {conversations && directory ? (
          <Conversations token={token} list={conversations.conversations} names={directory.participants.map((p) => p.name)} selected={selected} onOpen={open} />
        ) : (
          <p className="muted">Loading…</p>
        )}
      </section>
      <section className="pane conversation">
        {selected ? (
          <ConversationView
            key={selected}
            token={token}
            id={selected}
            as={as}
            names={directory?.participants.map((p) => p.name) ?? []}
            unread={isPerson && unreadConversations.has(selected)}
          />
        ) : (
          <p className="muted">Pick a conversation.</p>
        )}
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Promotion (shown under the agent registry)

function Promote({ token, machines, people }: { token: string; machines: string[]; people: string[] }) {
  const promote = useMutation(api.directory.promote);
  const [name, setName] = useState("");
  const [harness, setHarness] = useState<"t3" | "claude-code">("t3");
  const [machine, setMachine] = useState(machines[0] ?? "");
  const [locator, setLocator] = useState("");
  const [owner, setOwner] = useState(people.includes("lee") ? "lee" : people[0] ?? "");
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => {
    if (!machine && machines[0]) setMachine(machines[0]);
  }, [machines, machine]);
  useEffect(() => {
    if (!people.includes(owner) && people.length > 0) setOwner(people.includes("lee") ? "lee" : people[0]!);
  }, [people, owner]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const parsed = parsePromotion({ name, harness, machine, locator, owner }, people);
    if (!parsed.ok) return setNote({ ok: false, text: parsed.error });
    const { home } = parsed.value;
    promote({ adminToken: token, ...parsed.value })
      .then(() => {
        setNote({
          ok: true,
          text:
            harness === "claude-code"
              ? `@${name} promoted, owned by @${owner}. Start its terminal with AGENT_COMMS_PARTICIPANT=${name}.`
              : `@${name} promoted, owned by @${owner}; thread ${home.locator} on ${home.machine}.`,
        });
        setName("");
        setLocator("");
      })
      .catch((e: Error) => setNote({ ok: false, text: e.message }));
  };

  return (
    <form className="card" onSubmit={submit}>
      <h3>Promote an agent</h3>
      <label>
        Name <input value={name} onChange={(e) => setName(e.target.value.toLowerCase())} placeholder="cedar" />
      </label>
      <label>
        Lives in
        <select value={harness} onChange={(e) => setHarness(e.target.value as "t3" | "claude-code")}>
          <option value="t3">a T3 thread</option>
          <option value="claude-code">a Claude Code terminal</option>
        </select>
      </label>
      <label>
        Machine
        <input list="machines" value={machine} onChange={(e) => setMachine(e.target.value)} />
        <datalist id="machines">{machines.map((m) => <option key={m} value={m} />)}</datalist>
      </label>
      {harness === "t3" && (
        <label>
          T3 thread id <input value={locator} onChange={(e) => setLocator(e.target.value)} />
        </label>
      )}
      <label>
        Owner
        <select value={owner} onChange={(e) => setOwner(e.target.value)}>
          {people.map((p) => <option key={p} value={p}>@{p}</option>)}
        </select>
      </label>
      <button type="submit">Promote</button>
      {note && <p className={note.ok ? "ok" : "error"}>{note.text}</p>}
    </form>
  );
}

// ---------------------------------------------------------------------------
// Conversations

type ConversationList = NonNullable<ReturnType<typeof useQuery<typeof api.conversations.list>>>["conversations"];

function Conversations(props: { token: string; list: ConversationList; names: string[]; selected: string | null; onOpen: (id: string) => void }) {
  const createGroup = useMutation(api.conversations.createGroup);
  const [title, setTitle] = useState("");
  const [members, setMembers] = useState("");
  const [error, setError] = useState<string | null>(null);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const names = mentions(members, props.names);
    createGroup({ adminToken: props.token, title: title.trim(), members: names })
      .then((r) => {
        setTitle("");
        setMembers("");
        setError(null);
        props.onOpen(r.conversation.id);
      })
      .catch((err: Error) => setError(err.message));
  };

  return (
    <>
      <h2>Conversations</h2>
      <ul className="convs">
        {props.list.map((c) => (
          <li key={c.id} className={c.id === props.selected ? "on" : ""} onClick={() => props.onOpen(c.id)}>
            <span className="name">{c.kind === "group" ? c.title : c.members.map((m) => `@${m.name}`).join(" · ")}</span>
            <span className="muted small">
              {c.kind} · {plural(c.members.length, "member")} · {plural(c.lastSeq, "message")}
            </span>
          </li>
        ))}
        {props.list.length === 0 && <li className="muted">No conversations yet.</li>}
      </ul>
      <form className="card" onSubmit={submit}>
        <h3>New group</h3>
        <label>
          Title <input value={title} onChange={(e) => setTitle(e.target.value)} />
        </label>
        <label>
          Members <input value={members} onChange={(e) => setMembers(e.target.value)} placeholder="@lee @cedar @hazel" />
        </label>
        <button type="submit" disabled={!title.trim()}>Create</button>
        {error && <p className="error">{error}</p>}
      </form>
    </>
  );
}

// ---------------------------------------------------------------------------
// One conversation

function ConversationView({ token, id, as, names, unread }: { token: string; id: string; as: string; names: string[]; unread: boolean }) {
  const view = useQuery(api.conversations.view, { adminToken: token, conversationId: id });
  const markRead = useMutation(api.inbox.markRead);
  // Open is read: whatever in this conversation is in @as's inbox is marked read,
  // including messages that arrive while it's open.
  useEffect(() => {
    if (unread && view) markRead({ adminToken: token, human: as, conversationId: id }).catch(() => {});
  }, [unread, view, token, as, id, markRead]);
  const post = useMutation(api.conversations.postAs);
  const addMember = useMutation(api.conversations.addMember);
  const removeMember = useMutation(api.conversations.removeMember);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState("");

  const memberNames = useMemo(() => view?.members.map((m) => m.name) ?? [], [view]);
  const [sending, setSending] = useState(false);
  const mentioned = mentions(text, memberNames).filter((n) => n !== as);
  // In a DM with no @mention, the message goes to the other member (3.5).
  const dmOther = view?.conversation.kind === "dm" ? memberNames.filter((n) => n !== as) : [];
  const addressed = mentioned.length > 0 ? mentioned : dmOther.length === 1 ? dmOther : [];

  useEffect(() => {
    document.querySelector(".messages")?.scrollTo({ top: 1e9 });
  }, [view?.messages.length]);

  if (!view) return <p className="muted">Loading…</p>;
  const c = view.conversation;
  const byId = new Map(view.messages.map((m) => [m.message.id, m.message]));

  const send = (e: FormEvent) => {
    e.preventDefault();
    if (!text.trim() || sending) return;
    const sent = text;
    setSending(true);
    post({ adminToken: token, as, conversationId: id, to: addressed, text: sent.trim() })
      .then(() => {
        // Clear only what was sent; anything typed meanwhile stays (3.5).
        setText((current) => (current === sent ? "" : current));
        setError(null);
      })
      .catch((err: Error) => setError(err.message))
      .finally(() => setSending(false));
  };

  return (
    <div className="convo">
      <div className="convo-head">
        <h2>{c.kind === "group" ? c.title : view.members.map((m) => `@${m.name}`).join(" · ")}</h2>
        <div className="members small">
          {view.members.map((m) => (
            <span key={m.id} className="chip">
              @{m.name}
              {c.kind === "group" && (
                <button
                  className="x"
                  title={`Remove @${m.name}`}
                  onClick={() => removeMember({ adminToken: token, conversationId: id, name: m.name }).catch((e: Error) => setError(e.message))}
                >
                  ×
                </button>
              )}
            </span>
          ))}
          {c.kind === "group" && (
            <form
              className="inline"
              onSubmit={(e) => {
                e.preventDefault();
                const name = adding.replace(/^@/, "").trim();
                if (name) addMember({ adminToken: token, conversationId: id, name }).then(() => setAdding("")).catch((err: Error) => setError(err.message));
              }}
            >
              <input list="all-names" value={adding} onChange={(e) => setAdding(e.target.value)} placeholder="add @name" size={10} />
              <datalist id="all-names">{names.filter((n) => !memberNames.includes(n)).map((n) => <option key={n} value={n} />)}</datalist>
            </form>
          )}
        </div>
      </div>
      <ol className="messages">
        {view.messages.map(({ message: m, deliveries }) => {
          const answered = m.inReplyTo ? byId.get(m.inReplyTo) : undefined;
          return (
            <li key={m.id} className={`msg ${m.kind} ${m.sender.name === as ? "mine" : ""}`}>
              <div className="meta small">
                <span className="muted">#{m.seq}</span> <strong>@{m.sender.name}</strong>
                {m.recipients.length > 0 && <> → {m.recipients.map((r) => `@${r.name}`).join(", ")}</>}
                {m.inReplyTo && (
                  <span className="muted">
                    {" "}
                    · {m.collectedFrom ? "answer" : "reply"} to {answered ? `#${answered.seq}` : m.inReplyTo}
                  </span>
                )}
                <span className="muted"> · {time(m.createdAt)} · via {m.origin.via}</span>
              </div>
              <div className="text">{m.text}</div>
              {deliveries.length > 0 && (
                <div className="deliveries">
                  {deliveries.map((d) => (
                    <span key={d.id} className={`badge ${d.state}`} title={d.detail ?? `${d.state} at ${time(d.at)}`}>
                      @{d.recipient}: {d.state}
                      {(d.state === "uncertain" || d.state === "ambiguous" || d.state === "failed") && d.detail ? ` (${d.detail})` : ""}
                    </span>
                  ))}
                </div>
              )}
            </li>
          );
        })}
        {view.messages.length === 0 && <li className="muted">No messages yet.</li>}
      </ol>
      <form className="composer" onSubmit={send}>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          readOnly={sending}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) send(e);
          }}
          placeholder={c.kind === "dm" ? "Message" : "Message; @name wakes that member"}
          rows={3}
        />
        <div className="send-row small">
          <span className="muted">
            {addressed.length > 0
              ? `wakes ${addressed.map((n) => `@${n}`).join(", ")}${mentioned.length === 0 ? " (the other member of this DM)" : ""}`
              : "wakes no one: nobody is @mentioned"}
          </span>
          <button type="submit" disabled={!text.trim() || sending}>{sending ? "Sending…" : "Send"}</button>
        </div>
        {error && <p className="error">{error}</p>}
      </form>
    </div>
  );
}

// ---------------------------------------------------------------------------

/** The @names in `text` that are in `known`, in order, once each. */
function mentions(text: string, known: string[]): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(/@([a-z0-9][a-z0-9_-]{0,47})/g)) {
    const name = match[1]!;
    if (known.includes(name) && !out.includes(name)) out.push(name);
  }
  return out;
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

function time(ms: number): string {
  const d = new Date(ms);
  const today = new Date().toDateString() === d.toDateString();
  return today ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : d.toLocaleString([], { dateStyle: "short", timeStyle: "short" });
}

function useNow(everyMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(t);
  }, [everyMs]);
  return now;
}
