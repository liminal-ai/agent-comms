# Comms lane: the comms server, connector and T3 adapter

For the comms builder. Read [`00-overview.md`](./00-overview.md) first: it has the model, the delivery guarantees, the stack and the working rules on this box. This document is the work breakdown.

You own `packages/protocol` (the contract), the repo root files, and everything in `agent-comms` except `packages/claude-code-mod`, which the T3 builder owns. Progress goes in `PROGRESS-comms.md`.

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
  apps/web/                  Lee's chat, groups and directory view
  docs/
  PROGRESS-comms.md
  PROGRESS-t3.md             owned by the T3 builder
```

Pin `effect` to T3 v0.0.44's catalog version, `4.0.0-rc.115`, in the connector and the adapter.

## Milestones, in order

### M0: the contract, CLI and stub (first, about half a day; the mod depends on it)

Write in `packages/protocol`:

1. **Message envelope:**
   - message id, conversation id, per-conversation `seq`;
   - sender participant, recipients (addressed participants);
   - `kind`: `request` or `answer`; `inReplyTo` for answers;
   - text, attachment references (not bytes), created time;
   - origin: `via` (`t3` | `claude-code` | `cli` | `web`) and an external id for echo suppression.
2. **Delivery:**
   - delivery id, message id, recipient;
   - state: `pending | claimed | delivered | replied | ambiguous | uncertain | failed`, with a timestamp and detail. `claimed` carries the claiming machine and a lease expiry;
   - the bounded history attached to it: the recent messages since the recipient's read position, capped by count and characters, and saying how many older ones were left out.
3. **How a delivery is shown to the model.** One rendering function, used by every adapter, and one matching parser.
   - The rendered text contains a fixed, machine-readable header line carrying the delivery id. The parser matches that header as a complete line anywhere in the text, never as a loose substring. Not at offset zero: Claude Code wraps a plugin's prompt, so the text the mod sees in `turn.start` begins with "The <plugin> plugin sent a message:" and ends with a sentence saying the plugin started the turn in the user's place (Wrenn, captured live).
   - The renderer takes whether the harness already labels the source. Claude Code does, so the mod's rendering doesn't repeat "a plugin sent this". T3 doesn't, so the T3 rendering includes a one-line source statement.
   - It states accurately what the message is: from which participant, in which conversation, addressed to which registered name (the recipient's own), and whether an answer is expected.
   - It says how to answer: normally just reply; use `comms reply <message-id>` if told the reply couldn't be matched, or for a follow-up that finishes after the turn.
   - It identifies the source; it doesn't ask the model to treat the message as the user's authority. Normal permission checks apply to anything the message asks for. Wrenn's spike saw Sonnet refuse bare `[from: …]` injections until the source was explicit; start from that finding.
4. **The loopback protocol** between the connector and local clients (the mod and the CLI). HTTP over a Unix socket at a fixed per-user path: `$XDG_RUNTIME_DIR/agent-comms/connector.sock` on Linux, `~/.agent-comms/connector.sock` on macOS, in a directory only the user can open (0700).
   - The connector creates that directory with mode 0700, and refuses to start if it already exists with wider permissions or another owner. On macOS there's no runtime directory doing this for us. Convex machine credentials are separate and unchanged.
   - **No token.** Owner-only directory permissions give the same protection: any process that could read a token file could also open the socket. And the mod can't read files outside the session's folder. This is the same trusted-machine footing as `--as`.
   - Verified (Reed, `/scratch/reed/modflag`): a mod reads `AGENT_COMMS_PARTICIPANT` with `$.env.get`, and `$.http.fetch` with `socketPath` reaches a socket under `/run/user/<uid>/`, outside the session folder.
   
   Operations:
   - **register:** participant, harness session id, cwd, status;
   - **poll for deliveries:** the mod calls this repeatedly. The connector holds the request open until a delivery is ready or a bounded wait (e.g. 20s) passes, then returns an empty result. The mod's `$.http.fetch` has no timeout option, so the bound must be on the connector side. A client has at most one poll outstanding; the connector rejects a second concurrent poll from the same session.
   - **ack delivered:** with the harness turn id it started;
   - **turn events and presence:** turn started, turn completed with the answer text, aborted; idle or busy;
   - **report outcome:** replied with the answer, ambiguous (with what entered the turn), or failed;
   - **send, reply, read, list:** what the CLI uses.
   
   Specify request and response JSON and error cases for each.
5. **Sender identity:** `--as <participant>`, accepted if that participant is homed on this machine. Document it in the protocol as a trusted-machine development shortcut, not proof of identity. Stock T3 gives an agent no way to learn its own thread id, so there is no automatic identity for now; the recipient name in every delivery is how an agent knows what to pass.

Then build, minimally:

- **`packages/comms-cli`:**
  - `comms send --as <me> (@name… | --conversation <id>) "text"`: a request;
  - `comms reply --as <me> <message-id> "text"`: an answer, with `inReplyTo`;
  - `comms read --as <me> <conversation> [--before <seq>] [--limit <n>]`: older history;
  - `comms list --as <me>`: my conversations.
  
  In M0 these talk to the stub; later to the real connector, unchanged.
- **`packages/connector-stub`:** serves the loopback protocol on the socket, hands out deliveries from a JSON file, records everything it receives, and holds polls like the real one. No Convex.

Commit M0 and tell Reed. The T3 builder reviews it (02, part C); changes go through you.

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
- **Directory:** promote (create a participant with a home), rebind the home, pause, resume, retire.
- **Conversations:** create a group, add and remove members, open a DM.
- **Send:** create a delivery for each addressed member who is active or paused (paused ones stay pending). None for retired.
- **Deliveries:**
  - a pending-deliveries query per machine;
  - claim with a lease, then state transitions. All idempotent on delivery id;
  - append a collected answer: at most one per delivery, keyed by delivery id, linked with `inReplyTo`;
  - append an explicit reply (`comms reply`): its own message id, the same `inReplyTo`, any number of them. It can also complete an ambiguous delivery.
- **Reads:** bounded history; presence heartbeat.
- **Web:** conversation list, posting as a human.
- **Invariant:** an answer is delivered to the requester, but the delivery it creates is never one whose output gets collected.

Development uses a local deployment, run by `npx convex dev` in its own memory-capped unit. Auth for development: a per-machine connector secret in config; Lee's web view uses a single dev admin token. Multi-human auth is out of scope.

Tests: Convex function tests for every state transition and invariant, including lease expiry and duplicate answers.

### M2: the connector (Effect)

- **Config file:** Convex deployment URL, machine id and connector secret, adapters to load, T3 base URL and auth reference, socket path.
- **Convex subscription** to pending deliveries for participants homed on this machine.
- **Claims:** claim with a lease, renew while working, and confirm the claim is still held (a compare-and-set on the claim id) immediately before handing the message to the harness. An expired claim is taken over only through the restart check below, never by running the delivery straight away.
- **Deliveries** run serially per participant, in parallel across participants.
- **Restart and takeover:**
  - claimed, not delivered: ask the adapter whether the harness already has it. Found: delivered. Absent: run it. Can't tell: `uncertain`;
  - delivered, not replied or ambiguous: ask the adapter for our turn. Finished: collect it by the usual rule. Running: resume watching. Not found: `uncertain`.
  - Never re-run blind.
- **The loopback server** from M0: the real version of the stub.
- **Writes are asynchronous and off the harness's turn path.** If Convex is unreachable, keep retrying with backoff, mark presence stale, and never block a harness. There's no local queue, so a message not yet accepted by Convex can be lost if the connector crashes. That's the agreed trade-off; log it.
- **Runs as** a memory-capped `systemd --user` service here, and a launchd agent on macOS later.

### M3: the T3 adapter

Reference implementation: `/srv/work/long-horizon-context/packages/t3code-inject`. It already drives stock T3 over its WebSocket RPC: `orchestration.dispatchCommand` with `thread.turn.start`, `orchestration.subscribeThread` for events, and `waitForTurn` for matching. Use the T3 builder's API notes when they land; start against stock v0.0.44 before that.

- **Deliver:** wait until the thread is idle, then `thread.turn.start` with the rendered delivery as the user message and a message id the adapter chooses. Waiting is only a courtesy, since a person can start a turn in between: ownership comes from events, not from the wait.
  - v0.0.44 has no server-side queue, and a turn start on a busy thread steers the running turn. The T3 builder confirms that per provider.
- **Ownership and matching:** `thread.message-sent` carries `messageId` and `turnId`. Our message's event gives our turn id; mark delivered.
  - If another user message arrives with the same `turnId`, the delivery is ambiguous.
  - Otherwise, when that turn completes, its final assistant message is the answer: write it with `inReplyTo`, and mark replied.
  - If our message landed in a turn someone else started (steered in), it's ambiguous.
  - Deliveries of kind `answer` are delivered, never collected.
- **Restart check:** look in the thread for our message id, and for the state of the turn it went into.
- **Presence:** idle or busy, from the thread's session state.
- **Never read or forward anything else from the thread.**

### M4: the web view

A static app on Convex:
- directory with presence; promote an existing T3 thread by id; promote a terminal agent (creates the participant; the terminal is then started with that name, see 02 part D); pause, resume, retire;
- conversation list; create a group; add and remove members;
- conversation view with delivery state per addressed agent, and `uncertain` deliveries highlighted;
- posting as Lee, with @mentions.

Keep it plain; T3-panel embedding is later.

### M5: first milestone (local)

Two agents in the fresh T3 (port 3780), a native Claude thread and a Codex thread, are promoted:
- one sends the other a request with `comms send` and gets the matched answer back in its own thread;
- Lee posts in a group addressing both, and both replies land linked to his message;
- a busy-thread delivery waits, then runs as its own turn;
- a message typed into the same turn makes the delivery ambiguous, and `comms reply` completes it;
- the connector is killed mid-delivery and restarted, with no double run.

Record evidence in `validation/`.

### M6: integration, then the cloud checkpoint

1. Swap the stub for the real connector in the T3 builder's mod tests, and run the shared acceptance check in the overview together.
2. **Cloud checkpoint,** separately: deploy the functions to a cloud Convex project; issue the connector's machine credential; point the connector and the web app at it; seed or migrate the participants; rerun the acceptance check. Then a second machine (the M5 MacBook) with its own connector, and one cross-host request each way.

## Don't

- Don't capture or copy agents' private thread content.
- Don't add Redis, a local queue, or local-to-cloud Convex sync.
- Don't build per-agent credentials or an auth platform.
- Don't patch T3. If the adapter needs something T3 doesn't expose, report it to Reed.
- Don't guess reply attribution, and don't re-run an uncertain delivery.
