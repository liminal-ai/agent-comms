# Agent comms: overview

Shared context for both builders. Read this first, then your own lane document:

- Comms server lane: [`01-comms-lane.md`](./01-comms-lane.md)
- T3 lane (then the Claude Code mod): [`02-t3-lane.md`](./02-t3-lane.md)

Draft by Reed, 2026-09-30. Reviewers: Alder (scope, contracts, acceptance), Wrenn (technical claims, mod details).
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
- **Build small, add machinery only for failures we actually see.** No Redis, no local queue, no full-transcript capture in this version.

## What we are building

A **comms server**: one shared record of participants and conversations, with connectors that deliver messages into wherever each agent lives, and collect the replies.

In scope:

- a participant directory (people and promoted agents, each with a home: machine, harness, thread or session);
- conversations: DMs and groups, which are the same thing with different member counts;
- delivery of addressed messages into agent homes, and collection of the answers;
- a web view for Lee to read and post, and see who is online;
- the T3 connector adapter, and a Claude Code adapter (a mod).

Out of scope for this plan: Slack and iMessage bridges, Hermes, a standalone Codex app-server adapter, memory, orchestration, capturing agents' private work, scheduled goals, local queuing or offline buffering.

## The model

- **A conversation is a row in Convex.** It is the venue. Slack, iMessage and the web view are only windows onto it. Two T3 agents talking never touch Slack.
- **Participants have homes.** Promoting an agent registers its address and home. The agent keeps running where it is, with its own history. Moving an agent redirects delivery only.
- **Addressed wakes, visible doesn't.** An @mention creates a delivery. Other members read the message as history on their next turn.
- **Requests and answers.** A message is a request (expects an answer) or an answer. Only requests get their reply collected, and an answer never triggers a reply of its own, so agents can't loop.
- **Reply matching is never guessed.** A reply is collected automatically only when the connector started that turn and nothing else entered it. Otherwise the delivery is marked ambiguous, and the agent answers with `comms send`.
- **Private work stays private.** Lee typing to an agent in its own thread never reaches the comms server. Sharing is always an explicit send.
- **Every delivery carries bounded context:** the recent messages in that conversation since the recipient last read, capped. Older ones are readable on request.

## Architecture

```
Convex (comms server: participants, conversations, members, messages, deliveries)
   ↕  outbound subscriptions + mutations, async, never on a harness's turn path
connector (one Effect service per machine)
   ├─ T3 adapter (in the connector) ── T3 server API ── T3 threads (Claude, Claude-LHC, Codex)
   └─ loopback endpoint ── Claude Code mod (inside each Claude Code terminal session)
comms CLI (`comms send`): any agent starts a new message through its local connector
apps/web: Lee's chat and directory view, straight on Convex
```

- **Convex** stores everything shared and pushes changes. Local Convex during development, cloud Convex for cross-host testing. The connector reads its deployment URL from config from day one, so the switch is a config change.
- **The connector** runs on every machine that hosts agents. It subscribes to deliveries for the participants homed there, delivers them, and writes back replies, presence and delivery states.
- **Adapters** live wherever the harness can be controlled from. T3 has a server API, so its adapter runs inside the connector. A Claude Code terminal has no outside API, so its adapter is a mod running inside Claude Code, talking to the connector over a local socket.
- **Claude running inside T3 uses the T3 adapter,** not the mod. The mod is only for standalone Claude Code terminal sessions.

Scenario flows (T3↔T3, Claude Code↔Claude Code, groups, reply matching, tracking) are in the walkthrough linked above.

## Stack

- Convex functions: TypeScript.
- Connector: Effect, pinned to the Effect version T3 v0.0.44 uses (`4.0.0-rc.115`), so the T3 adapter can reuse T3's contract types. Do not use the August code's Effect pin.
- `packages/protocol`: plain TypeScript, no Effect, importable by Convex, the connector, the CLI, the mod and the web app.
- The mod and the `comms` CLI: plain TypeScript. Claude Code runs the mod in its own runtime, and the CLI must start fast from any shell.
- One monorepo: `/srv/work/agent-comms`. These documents live in its `docs/`.

## The plan: two builders

Two fresh native T3 threads, Opus 5.5 at high effort, on lim-builder.

| Lane | Builder | Work |
|---|---|---|
| Comms | comms builder | The contract first, then Convex, the connector, the T3 adapter, the CLI, the web view |
| T3, then mod | T3 builder | A clean T3 v0.0.44 with the claude-lhc provider; T3 API notes for the adapter; then the Claude Code mod |

Sequence:

1. **Both start at once.**
   - Comms builder writes the contract first: the message envelope, the loopback protocol, and a stub connector (01, milestone M0). That's about half a day, and it's what the mod depends on.
   - T3 builder installs and patches T3, and writes the API notes (02, parts A and B).
2. **Handoff 1:** T3 builder gives the comms builder the fresh T3's address, auth setup and API notes. The comms builder can start the adapter against stock v0.0.44 before this, and switch to the notes when they land.
3. **Handoff 2:** T3 builder reviews the contract (02, part C) and proposes changes. The comms builder owns the contract and makes them.
4. **T3 builder builds the mod** against the stub connector (02, part D), while the comms builder finishes the real connector, adapter and web view.
5. **Integration:** swap the stub for the real connector and run the shared acceptance check.

Ownership:

- `packages/protocol`: comms builder. It is the single source of truth for the contract; the documents point to it rather than restating it.
- The T3 checkout and install: T3 builder.
- `packages/claude-code-mod`: T3 builder.
- Everything else in `agent-comms`: comms builder.

## Shared acceptance check (end of the plan)

On lim-builder, with local Convex:

1. A native Claude thread and a Claude-LHC thread in the fresh T3, and a Claude Code terminal with the mod, are promoted and show online in the web view.
2. Each sends a request to another; every request is delivered, answered and the answer matched to it, across all three homes.
3. Lee posts in a group addressing two of them. Only those two are woken, and both replies land in the group linked to Lee's message.
4. Lee types directly into one agent's T3 thread while a comms request is running there. The delivery is marked ambiguous, not mis-attributed, and the agent's `comms send` answer reaches the requester.
5. Nothing Lee typed directly into an agent's thread appears in Convex.
6. Answers never produce a reply of their own; no loop.
7. The same run against cloud Convex, by changing only the connector's config.

## Working rules on lim-builder

- Don't touch the running t3code-lhc service on port 3773, its data folder, or any live seat.
- Builds and test runs go in memory-capped `systemd-run --user` units, outside `t3code-3773.service`, with `SSH_AUTH_SOCK` and `GIT_SSH_COMMAND` unset.
- Never read, print or copy credentials, including `~/.claude/settings.json`, proxy config, or T3 secret files. Tests use dummy values.
- Helpers run through `claude-subagent start`, not built-in background agents.
- Don't reverse-engineer Claude Code internals, including its binary and internal sockets. Use documented surfaces only: the mods API and its types, and the T3 contracts.
- Commit per step, record progress in `PROGRESS.md` in the repo, and report blockers to Reed.
