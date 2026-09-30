# Comms lane: the comms server, connector and T3 adapter

For the comms builder. Read [`00-overview.md`](./00-overview.md) first: it has the model, the rules, the stack and the working rules on this box. This document is the work breakdown.

You own `packages/protocol` (the contract), and everything in `agent-comms` except `packages/claude-code-mod`, which the T3 builder owns.

## Repo layout

```
agent-comms/
  convex/                    schema + functions (the comms server)
  packages/protocol/         envelope, loopback contract, shared types. Plain TS, no Effect
  packages/connector/        the per-machine service (Effect)
  packages/connector-stub/   stub connector for mod development (M0)
  packages/adapter-t3/       T3 adapter, loaded by the connector
  packages/comms-cli/        `comms` CLI. Plain TS, fast start
  packages/claude-code-mod/  owned by the T3 builder
  apps/web/                  Lee's chat and directory view
  docs/
  PROGRESS.md
```

Pin `effect` to T3 v0.0.44's catalog version, `4.0.0-rc.115`, in the connector and the adapter.

## Milestones, in order

### M0: the contract and a stub (first, about half a day; the mod depends on it)

Write in `packages/protocol`:

1. **Message envelope:**
   - message id, conversation id, per-conversation `seq`;
   - sender participant, recipients (addressed participants);
   - `kind`: `request` or `answer`; `inReplyTo`;
   - text, attachment references (not bytes), created time;
   - origin: `via` (`t3` | `claude-code` | `cli` | `web`) and an external id for echo suppression.
2. **Delivery:**
   - delivery id, message id, recipient;
   - state: `pending | delivered | replied | ambiguous | failed`, with a timestamp and detail;
   - the bounded history attached to it: the recent messages since the recipient's read position, capped by count and characters, and saying how many older ones were left out.
3. **How a delivery is shown to the model.** One rendering function used by every adapter, so the trust problem is solved once. It must:
   - name the sender and the conversation;
   - say whether an answer is expected;
   - say how to answer: just reply, or `comms send` when told the reply couldn't be matched.
   
   Wrenn's mod spike found that Sonnet refused bare `[from: …]` injections as suspicious until the source was explicit. Start from that finding.
4. **The loopback protocol** between the connector and adapters that run inside a harness (the mod). Required operations:
   - **register:** participant id, harness session id, name, cwd, status;
   - **receive deliveries:** a push stream to the in-harness adapter. At-least-once, with the delivery id for dedupe;
   - **ack:** delivered, including the harness turn id it started;
   - **turn events:** turn started, turn completed with the answer text, or aborted; plus presence (idle/busy);
   - **report outcome:** replied with the answer, ambiguous (another input entered the turn), or failed;
   - **send:** a new message from the agent.
   
   Transport:
   - HTTP over a Unix socket at a fixed per-user path, such as `$XDG_RUNTIME_DIR/agent-comms/connector.sock`. Include `~/.agent-comms/connector.sock` for macOS. Authenticate with a token read from a file next to it, mode 0600.
   - The mod API's `$.http.fetch` supports a `socketPath` option, but reads whole bodies. So the push stream should be a long-lived `comms attach --participant <id> --session <id>` process that the mod starts with `$.process.spawn`, which prints one JSON delivery per line.
   - Specify both halves, with JSON shapes and error cases.
5. **Participant identity for the CLI:**
   - how `comms send` knows who is sending. The T3 builder is checking whether a stock T3 thread exposes its thread id to the agent (02, part B);
   - until then, design for an explicit `--as <participant>`, checked by the connector against participants homed on this machine.
   - Record the decision in the protocol docs.

Then build `packages/connector-stub`: a small process that serves the loopback protocol on the socket, reads deliveries to push from a JSON file, and logs everything it receives. No Convex.

Commit M0 and tell Reed. The T3 builder reviews it, and changes go through you (02, part C).

### M1: Convex schema and functions (local deployment)

Tables, borrowing ideas from `/srv/work/agent-control-plane/convex/schema.ts` but not its code:

| Table | Holds |
|---|---|
| `participants` | id, name (unique, addressable), owner, kind (`human` / `agent`), state (`active` / `paused` / `retired`), home `{machine, harness, locator}`, presence `{status, at}` |
| `conversations` | id, kind (`dm` / `group`), title |
| `members` | conversation, participant, read position (`seq`) |
| `messages` | the envelope above |
| `deliveries` | the delivery above |
| `machines` | machine id, connector credential hash, last seen |

Functions:
- **Directory:** promote (create a participant with a home), rebind the home, pause, retire.
- **Send:** resolve DMs; create a delivery per addressed agent that is active and a member.
- **Deliveries:** a pending-deliveries query per machine; state transitions, which must be idempotent on delivery id; append an answer, linked with `inReplyTo`.
- **Reads:** a bounded history query; presence heartbeat.
- **Web:** the conversations list, posting as a human.
- **Invariants:**
  - an `answer` never creates deliveries that expect a reply;
  - a paused participant's deliveries stay pending;
  - a retired participant gets no deliveries.

Development runs a local deployment: `npx convex dev`, with the deployment selected as local. Local Convex runs as a subprocess of `convex dev`, so run it in its own memory-capped unit. Auth for development: a per-machine connector secret in config; Lee's web view uses a single dev admin token. Multi-human auth is out of scope.

Tests: Convex function tests for every state transition and invariant.

### M2: the connector (Effect)

- **Config file:**
  - Convex deployment URL: local now, cloud later, with no code change;
  - machine id and connector secret;
  - which adapters to load;
  - T3 base URL and auth reference;
  - the socket path.
- **Convex subscription** to pending deliveries for participants homed on this machine.
- **Deliveries** are processed serially per participant, and in parallel across participants.
- **Presence** is reported from each adapter.
- **The loopback server** from M0: the real version of the stub.
- **Writes are asynchronous and off the harness's turn path.** If Convex is unreachable, the connector keeps retrying with backoff, marks presence stale, and never blocks a harness. There's no local queue: a message not yet accepted by Convex can be lost if the connector crashes. That's the agreed trade-off; log it.
- **Runs as** a `systemd --user` service here, memory-capped, and a launchd agent on macOS later.

### M3: the T3 adapter

Reference implementation: `/srv/work/long-horizon-context/packages/t3code-inject`. It already drives stock T3 over its WebSocket RPC: `orchestration.dispatchCommand` with `thread.turn.start`, and `orchestration.subscribeThread` for events. Use the T3 builder's API notes when they land; start against stock v0.0.44 before that.

- **Deliver:**
  - if the thread is idle, start a turn with the rendered delivery as the user message. Record the message id and turn id; mark delivered.
  - if the thread is busy: in v0.0.44, `thread.turn.start` on a busy thread steers the running turn, and there's no server-side queue command. So by default the adapter holds the delivery until the thread is idle, then starts its own turn. That keeps it the sole input, the same pattern as t3code-inject's queue. The T3 builder confirms the busy behavior for Claude and Codex threads.
- **Collect the reply:** when the turn the adapter started completes, check whether any other user message entered that turn.
  - If none, its final assistant message is the answer: write it with `inReplyTo`, and mark the delivery replied.
  - If another input entered, mark the delivery ambiguous, and tell the agent to answer with `comms send`.
  - Answers delivered to an agent are never collected.
- **Presence:** idle or busy, from the thread's session state.
- **Never read or forward anything else from the thread.**

### M4: the web view

A static app on Convex:
- the directory, with presence;
- the conversation list;
- the conversation view, with delivery state per addressed agent;
- posting as Lee, with @mentions;
- promoting an existing T3 thread by id.

Keep it plain; T3-panel embedding is later.

### M5: first milestone

Two agents in the fresh T3 (T3 lane, port 3780), a native Claude thread and a Codex thread, are promoted:
- one sends the other a request with `comms send`, and gets the matched answer back in its own thread;
- Lee posts in a group addressing both, and both replies land linked to his message;
- a busy-thread delivery waits and then runs as its own turn;
- a typed-in-mid-turn case is marked ambiguous.

Record evidence in `validation/`.

### M6: integration with the mod

Swap the stub connector for the real one in the T3 builder's mod tests, and run the shared acceptance check in the overview together.

## Don't

- Don't capture or copy agents' private thread content.
- Don't add Redis, a local queue, or local-to-cloud Convex sync.
- Don't patch T3. If the adapter needs something T3 doesn't expose, report it to Reed.
- Don't guess reply attribution.
- Don't let answers trigger deliveries that expect replies.
