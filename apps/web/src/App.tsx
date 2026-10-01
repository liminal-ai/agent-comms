// Lee's view onto the comms server. Plain on purpose: directory, conversations,
// one conversation with its delivery states, and a composer. Everything is a
// live Convex subscription; the dev admin token is kept in localStorage.

import { NAME_PATTERN } from "@agent-comms/protocol";
import { useMutation, useQuery } from "convex/react";
import { Component, type FormEvent, type ReactNode, useEffect, useMemo, useState } from "react";
import { api } from "../../../convex/_generated/api";

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

type Tab = "directory" | "conversations" | "conversation";

function Main({ token }: { token: string }) {
  const directory = useQuery(api.directory.list, { adminToken: token });
  const conversations = useQuery(api.conversations.list, { adminToken: token });
  const [selected, setSelected] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("conversations");
  const people = directory?.participants.filter((p) => p.kind === "human") ?? [];
  const [as, setAs] = useState(() => localStorage.getItem(AS_KEY) ?? "lee");
  useEffect(() => localStorage.setItem(AS_KEY, as), [as]);

  const open = (id: string) => {
    setSelected(id);
    setTab("conversation");
  };

  return (
    <div className="app" data-tab={tab}>
      <header>
        <strong>agent comms</strong>
        <nav>
          <button className={tab === "directory" ? "on" : ""} onClick={() => setTab("directory")}>Directory</button>
          <button className={tab === "conversations" ? "on" : ""} onClick={() => setTab("conversations")}>Conversations</button>
          {selected && <button className={tab === "conversation" ? "on" : ""} onClick={() => setTab("conversation")}>Open</button>}
        </nav>
        <label className="as">
          posting as
          <select value={as} onChange={(e) => setAs(e.target.value)}>
            {people.length === 0 && <option value={as}>@{as}</option>}
            {people.map((p) => <option key={p.id} value={p.name}>@{p.name}</option>)}
          </select>
        </label>
      </header>
      <section className="pane directory">
        {directory ? <Directory token={token} data={directory} /> : <p className="muted">Loading…</p>}
      </section>
      <section className="pane conversations">
        {conversations && directory ? (
          <Conversations token={token} list={conversations.conversations} names={directory.participants.map((p) => p.name)} selected={selected} onOpen={open} />
        ) : (
          <p className="muted">Loading…</p>
        )}
      </section>
      <section className="pane conversation">
        {selected ? <ConversationView key={selected} token={token} id={selected} as={as} names={directory?.participants.map((p) => p.name) ?? []} /> : <p className="muted">Pick a conversation.</p>}
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Directory

type DirectoryData = NonNullable<ReturnType<typeof useQuery<typeof api.directory.list>>>;

const ONLINE_MS = 90_000;

/**
 * What the directory shows for a participant (3.4):
 * - stale: its machine's connector hasn't been heard from (it heartbeats every 30 s),
 *   so whatever presence was last written can't be trusted;
 * - unconnected: a Claude Code terminal with no mod session registered with a live
 *   connector. Not proof the mod failed to load: the terminal may simply not be running;
 * - offline: a T3 participant whose thread or T3 can't be reached;
 * - idle / busy: as reported.
 */
function presenceOf(
  p: { kind: string; home?: { harness: string }; presence: { status: string; at: number } },
  seen: number | null,
  now: number,
): { status: "person" | "stale" | "unconnected" | "offline" | "idle" | "busy"; label: string } {
  if (p.kind === "human") return { status: "person", label: "person" };
  if (seen === null || now - seen >= ONLINE_MS) {
    const since = seen === null ? "never" : `since ${new Date(seen).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
    return { status: "stale", label: `connector not heard from ${since}` };
  }
  if (p.presence.status === "offline") {
    return p.home?.harness === "claude-code"
      ? { status: "unconnected", label: "mod not connected" }
      : { status: "offline", label: "offline (T3 or its thread unreachable)" };
  }
  return p.presence.status === "busy" ? { status: "busy", label: "busy" } : { status: "idle", label: "idle" };
}

function Directory({ token, data }: { token: string; data: DirectoryData }) {
  const setState = useMutation(api.directory.setState);
  const [error, setError] = useState<string | null>(null);
  const now = useNow(15_000);
  const machineSeen = new Map(data.machines.map((m) => [m.machineId, m.lastSeenAt]));

  const act = (name: string, state: "active" | "paused" | "retired") => {
    if (state === "retired" && !confirm(`Retire @${name}? It gets no more deliveries, and this can't be undone.`)) return;
    setState({ adminToken: token, name, state }).catch((e: Error) => setError(e.message));
  };

  return (
    <>
      <h2>Directory</h2>
      {error && <p className="error">{error}</p>}
      <ul className="people">
        {data.participants
          .slice()
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((p) => {
            const { status, label } = presenceOf(p, p.home ? machineSeen.get(p.home.machine) ?? null : null, now);
            return (
              <li key={p.id} className={`state-${p.state}`}>
                <span className={`dot ${status}`} title={label} />
                <span className="name">@{p.name}</span>
                <span className="muted small">
                  {p.home ? `${p.home.harness} · ${p.home.machine}` : "web"}
                  {p.state !== "active" && ` · ${p.state}`}
                  {p.kind === "agent" && (status === "stale" || status === "unconnected" || status === "offline") && ` · ${label}`}
                </span>
                {p.kind === "agent" && p.state !== "retired" && (
                  <span className="actions">
                    {p.state === "active" ? <button onClick={() => act(p.name, "paused")}>Pause</button> : <button onClick={() => act(p.name, "active")}>Resume</button>}
                    <button className="danger" onClick={() => act(p.name, "retired")}>Retire</button>
                  </span>
                )}
              </li>
            );
          })}
      </ul>
      <Promote token={token} machines={data.machines.map((m) => m.machineId)} />
    </>
  );
}

function Promote({ token, machines }: { token: string; machines: string[] }) {
  const promote = useMutation(api.directory.promote);
  const [name, setName] = useState("");
  const [harness, setHarness] = useState<"t3" | "claude-code">("t3");
  const [machine, setMachine] = useState(machines[0] ?? "");
  const [locator, setLocator] = useState("");
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => {
    if (!machine && machines[0]) setMachine(machines[0]);
  }, [machines, machine]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!NAME_PATTERN.test(name)) return setNote({ ok: false, text: "Names are lowercase letters, digits, - and _." });
    const home = { machine, harness, locator: harness === "claude-code" ? name : locator.trim() };
    if (harness === "t3" && !home.locator) return setNote({ ok: false, text: "Give the T3 thread id." });
    promote({ adminToken: token, name, kind: "agent", home })
      .then(() => {
        setNote({
          ok: true,
          text:
            harness === "claude-code"
              ? `@${name} promoted. Start its terminal with AGENT_COMMS_PARTICIPANT=${name}.`
              : `@${name} promoted; thread ${home.locator} on ${machine}.`,
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

function ConversationView({ token, id, as, names }: { token: string; id: string; as: string; names: string[] }) {
  const view = useQuery(api.conversations.view, { adminToken: token, conversationId: id });
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
