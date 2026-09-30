# Agent comms: overview

Shared context for Cedar and Hazel. Read this first, then your own lane document:

- Comms server lane: [`01-comms-lane.md`](./01-comms-lane.md)
- T3 lane (then the Claude Code mod): [`02-t3-lane.md`](./02-t3-lane.md)

Draft 3 by Reed, 2026-09-30, merging two rounds of review from Alder and Wrenn. Reviewers: Alder (scope, contracts, acceptance), Wrenn (technical claims, mod details).
Interactive architecture walkthrough: https://lim-builder.tailb30114.ts.net:10000/lhc/comms-architecture-reed.html

## The problem

Lee runs several long-lived coding agents (Claude, Claude-LHC and Codex threads in T3; Claude Code sessions in terminals; later Hermes bots), across several machines (lim-builder, two MacBooks, a Windows box). They need to:

- talk to each other: one agent asking another for a review, a status, a hand-off;
- talk in groups: Lee plus several agents in one conversation, where only the agents addressed are woken;
- be reachable from outside their own app, and later from Slack and iMessage, with other people and outside bots joining.

None of the agent harnesses provides this across harnesses or machines, and the consumer agent products (Dots, Grok Bot, Muse) only meet in chat apps.

## What we learned getting here

- **The LHC console** (Jul to Sep) routed Lee's iMessage and agent-to-agent messages into seats by injecting turns into T3 threads. It recorded only what it delivered, so anything typed in T3's UI never reached it. Its group chat grew around iMessage, which tied the group feature to one channel. An iMessage arriving during a UI turn could get the answer to a different prompt, because replies weren't matched to requests.
- **The August agent-control-plane** (Convex, Effect) had the right model: durable identities with a "home" binding, requests, deliveries and receipts, goals, and "addressed wakes, visible doesn't". It got through two epics and never carried a real seat. We borrow its schema ideas, not its code.
- **Forking harnesses is expensive.** The LHC forks of Codex, Claude Code and T3 cost most of two months of maintenance. This time T3 stays close to stock, and nothing is forked for comms.
- **Build small, add machinery only for failures we actually see.** No Redis, no local queue, no full-transcript capture, no new auth platform in this version.

## What we are building

A **comms server**: one shared record of participants and conversations, with connectors that deliver messages into wherever each agent lives, and collect the replies.

In scope:

- a participant directory (people and promoted agents, each with a home: machine, harness, thread or session);
- conversations: DMs and groups, which are the same thing with different member counts;
- delivery of addressed messages into agent homes, and collection of the answers;
- a `comms` CLI for agents, and a web view for Lee to read, post, manage groups, promote agents and see who is online;
- the T3 adapter, and a Claude Code adapter (a mod).

Out of scope for this plan: Slack and iMessage bridges, Hermes, a standalone Codex app-server adapter, memory, orchestration, capturing agents' private work, scheduled goals, local queuing or offline buffering, per-agent credentials.

## The model

- **A conversation is a row in Convex.** It is the venue. Slack, iMessage and the web view are only windows onto it. Two T3 agents talking never touch Slack.
- **Participants have homes.** Promoting an agent registers its address and home. The agent keeps running where it is, with its own history. Moving an agent redirects delivery only; its context stays where it was.
- **Addressed wakes, visible doesn't.** An @mention creates a delivery. Other members read the message as history on their next turn.
- **Requests and answers.** A message is a request (expects an answer) or an answer (carries `inReplyTo`). A request's reply is collected automatically. An answer is delivered to the requester and may wake it, but whatever the requester does next is never collected as a reply. That's what stops agents looping.
- **Paused and retired.** A paused agent's deliveries are created and stay pending until it resumes. A retired agent gets no deliveries.
- **Reply matching is never guessed.** A reply is collected automatically only when the adapter can see, from the harness's own events, that it started the turn and that nothing else was delivered into it. Work the turn itself started (its own tool calls, helpers, background tasks) doesn't count as something else. Anything else delivered into the turn, or anything that can't be linked, makes the delivery ambiguous, and the agent answers with `comms reply`. Input queued for a later turn doesn't affect it.
- **Private work stays private.** Lee typing to an agent in its own thread never reaches the comms server. Sharing is always an explicit send.
- **Every delivery carries bounded context:** the recipient's own registered name, and the recent messages in that conversation since the recipient last read, capped. Older ones are readable on request with `comms read`.

## Delivery guarantees

Stated plainly, so nobody builds against a promise we don't make:

- **Claims.** A connector claims a delivery with a lease, renews it while working, and checks it still holds the claim immediately before handing the message to the harness. The lease on its own doesn't prevent a double run: it only decides who may act.
- **`delivered` means the harness accepted our message:** T3 recorded our message id in the thread, or the mod saw a turn start carrying our delivery id.
- **Taking over a claim, or restarting, never re-runs blind.** For a claimed delivery not yet delivered, the connector looks in the harness for our message or delivery id. Found: mark delivered and carry on. Clearly absent: run it. Can't tell: `uncertain`, surfaced in the web view.
- **Delivered but not yet answered is recovered too.** If our turn has finished, collect its result. If it's still running, resume watching it. If it can't be found, `uncertain`.
- **Automatic collection is idempotent:** at most one collected answer per delivery, keyed by delivery id. Explicit follow-ups with `comms reply` are separate messages, each with its own id and the same `inReplyTo`, and are always allowed.
- **Not promised:** exactly-once execution in the harness, and survival of a message the connector hadn't yet written to Convex when it crashed. Both are accepted limits of this version.

## Architecture

```
Convex (comms server: participants, conversations, members, messages, deliveries, machines)
   ↕  subscriptions + mutations, async, never on a harness's turn path
connector (one Effect service per machine; a Unix socket, owner-only, for local clients)
   ├─ T3 adapter (inside the connector) ── T3 server API ── T3 threads (Claude, Claude-LHC, Codex)
   ├─ Claude Code mod (inside each Claude Code terminal) ── polls the connector's socket
   └─ comms CLI: send, reply, read, list, run by any agent from its shell
apps/web: Lee's chat, groups and directory view, straight on Convex
```

- **Convex** stores everything shared and pushes changes. Local Convex for development and the local acceptance check; cloud Convex is a separate checkpoint (see the comms lane, M6).
- **The connector** runs on every machine that hosts agents. It subscribes to deliveries for the participants homed there, delivers them, and writes back replies, presence and delivery states.
- **Adapters live wherever the harness can be controlled from.** T3 has a server API, so its adapter runs inside the connector. A Claude Code terminal has no outside API, so its adapter is a mod running inside Claude Code. The mod polls the connector over its local socket; there is no extra process per session.
- **Claude running inside T3 uses the T3 adapter,** not the mod. The mod is only for standalone Claude Code terminal sessions.
- **Sender identity is a development shortcut.** An agent names itself with `comms send --as <name>`, and the connector accepts any participant homed on that machine. That trusts every process on the machine; it's labelled as such, and proper per-agent credentials come later.

Scenario flows (T3↔T3, Claude Code↔Claude Code, groups, reply matching, tracking) are in the walkthrough linked above.

## Stack

- Convex functions: TypeScript.
- Connector and T3 adapter: Effect, pinned to T3 v0.0.44's catalog version (`4.0.0-rc.115`), so the adapter can reuse T3's contract types. Not the August code's pin.
- `packages/protocol`: plain TypeScript, no Effect, importable by Convex, the connector, the CLI, the mod and the web app.
- The mod and the `comms` CLI: plain TypeScript. Claude Code runs the mod in its own runtime, and the CLI must start fast from any shell.
- One monorepo: `/srv/work/agent-comms`. These documents live in its `docs/`.

## The plan: two agents

Two agents, each a native Claude thread (Opus 5.5, high effort) in the T3 on port 3773, each with its own home folder:

- **Cedar**, home `/srv/agents/cedar`, works in the worktree `/srv/agents/cedar/agent-comms` (branch `cedar`).
- **Hazel**, home `/srv/agents/hazel`, works in `/srv/agents/hazel/t3code-v044` and the worktree `/srv/agents/hazel/agent-comms` (branch `hazel`).

The main checkout `/srv/work/agent-comms` stays on `main`; Cedar merges both branches into it.

| Lane | Agent | Work |
|---|---|---|
| Comms | Cedar | The contract, CLI and stub first; then Convex, the connector, the T3 adapter, the web view |
| T3, then mod | Hazel | A clean T3 v0.0.44 with the claude-lhc provider; T3 API notes; then the Claude Code mod |

Sequence:

1. **Both start at once.**
   - Cedar writes M0: the envelope and its parser, the loopback protocol, a minimal `comms` CLI, and a stub connector. The mod depends on it.
   - Hazel installs and patches T3, and writes the API notes (02, parts A and B).
2. **Handoff 1:** Hazel gives Cedar the fresh T3's address, how to authenticate, the test thread ids, and the API notes. The Cedar can start the adapter against stock v0.0.44 before this.
3. **Handoff 2:** Hazel reviews M0 (02, part C) and proposes changes. The Cedar owns the contract and makes them.
4. **Hazel builds the mod** against the stub (02, part D), while Cedar finishes the real connector, adapter and web view.
5. **Integration:** swap the stub for the real connector and run the shared acceptance check. Then the cloud checkpoint.

Ownership:

- `packages/protocol`: Cedar. It is the single source of truth for the contract; the documents point to it rather than restating it.
- The T3 checkout and install: Hazel.
- `packages/claude-code-mod`: Hazel.
- Everything else in `agent-comms`, including the root `package.json`, lockfile, workspace config and `README.md`: Cedar. The Hazel asks for root changes.
- Progress: `PROGRESS-comms.md` and `PROGRESS-t3.md`, one per lane.

## Shared acceptance check (local)

On lim-builder, with local Convex:

1. A native Claude thread and a Claude-LHC thread in the fresh T3, and a Claude Code terminal with the mod, are promoted and show online in the web view.
2. Each sends a request to another with `comms send`; every request is delivered, answered, and the answer matched to it, across all three homes.
3. Lee creates a group in the web view and posts addressing two of them. Only those two are woken, and both replies land in the group linked to Lee's message.
4. Lee types directly into one agent's thread while a comms request is running there. If his message is delivered into that turn, the delivery is marked ambiguous, not mis-attributed, and the agent's `comms reply` reaches the requester. If it's queued for the next turn, the reply is collected normally.
5. A request whose answer needs the agent's own test run or helper is collected normally, provided the harness links that work to our turn. Where it can't (see 02, part D), the delivery is ambiguous and completed with `comms reply`; either outcome passes, as long as it's the one recorded.
6. Nothing Lee typed directly into an agent's thread appears in Convex.
7. An answer wakes the requester, and nothing the requester does next is collected; no loop.
8. The connector is killed mid-delivery and restarted: the delivery ends delivered, replied or `uncertain`, never run twice.

The cloud and cross-host checkpoint is separate (comms lane, M6).

## Working rules on lim-builder

- Each agent works only in its own worktree of `agent-comms`, on its own branch. Cedar merges into `main` in `/srv/work/agent-comms`; Hazel asks Cedar to merge.
- Don't touch the running t3code-lhc service on port 3773, its data folder, or any live seat.
- Builds and test runs go in memory-capped `systemd-run --user` units, outside `t3code-3773.service`, with `SSH_AUTH_SOCK` and `GIT_SSH_COMMAND` unset.
- **Credentials:** live turns use the credentials already configured for T3 and Claude Code. Never read, print or copy them, including `~/.claude/settings.json`, proxy config, or T3 secret files. Unit tests use dummy values.
- Helpers run through `claude-subagent start`, not built-in background agents.
- Don't reverse-engineer Claude Code internals, including its binary and internal sockets. Use documented surfaces only: the mods API and its types, and the T3 contracts.
- Commit per step, update your lane's progress file, and report blockers to Reed.
