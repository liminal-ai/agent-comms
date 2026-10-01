# Agent maintenance pass: homes, review forks, lifecycle and health

Draft 1 by Reed, 2026-10-01, from the lhc-group discussion with Lee, Alder and Wrenn. Review: Cedar and Hazel (buildability), then Alder (scope) and Wrenn (references).

**Prerequisite:** the capabilities pass is signed off (Wrenn's live retest and Alder's scope check). This pass uses its reminders, notices, inbox and registry.

## What this adds

Long-running agents keep their identity, role, memory and skills in a standard home folder. Periodically, a fork of each agent reviews its recent work and proposes what's worth keeping. A lifecycle agent on each host decides where each proposal belongs and applies it. A health agent on each host checks independently that agents and this process are healthy. Lee sees all of it, and approves what needs him, in the web view.

| Capability | Where |
|---|---|
| Standard agent home, with size budgets and a generated `AGENTS.md` | files on each host; `agent-home` tool |
| Review forks that propose, never write | fork launcher on each host |
| Proposals, queued per host, with decisions and history | Convex; `comms` commands |
| A lifecycle agent and a health agent per host | registry |
| Dashboard, agent pages, approvals inbox, roundtables | web view |

## Design

### 1. The agent home

```
/srv/agents/
  PLATFORM.md          shared: how this system works, comms, reminders, rules on this box
  OWNER.md             shared: how to work with Lee (one file for every agent)
  <name>/
    SOUL.md            identity and principles; changes only with Lee's approval
    ROLE.md            current duties and direction; changes as assignments change
    MEMORY.md          durable facts true in every session; capped
    PROGRESS.md        current work and handles; the agent edits it directly; never in AGENTS.md
    .claude/skills/    the agent's skills (Claude Code skill format)
    AGENTS.md          generated; never hand-edited; CLAUDE.md is a symlink to it
```

- `/srv/agents` is a git repository. Every change to a source file is a commit; the commit records who applied it and the proposal it came from.
- `ROLE.md` starts with a one-line **Direction:**, which the registry and web view show.
- **Budgets (starting values, tuned in use):** `SOUL` 3,000 characters, `ROLE` 3,000, `MEMORY` 3,000, `OWNER` 5,000, `PLATFORM` 8,000; the generated `AGENTS.md` at most 24,000 including the skills index. `agent-home build` refuses to generate if any part or the total is over.
- **Assembly order:** `SOUL`, `ROLE`, `OWNER`, `PLATFORM`, `MEMORY`, then the skills index (name and one-line description per skill). Stable parts first, so the most-changed part comes last.
- **Loading:** a rebuilt `AGENTS.md` is picked up whenever the harness next loads it (new session or compaction). Nothing forces a reload.
- **Memory rules,** adapted from Hermes: facts, not instructions to yourself; nothing stale within a week; no task progress or work logs (those belong in `PROGRESS.md` or history); a lesson learned doing a task belongs in that task's skill; one fact in one place.
- **Skill rules,** adapted from Hermes: class-level skills, procedure first, pitfalls as a rule plus the reason, no dates, ticket numbers or incident stories, fix a wrong line in place, read before editing.

### 2. The `agent-home` tool

A package in this repo, installed on each host like `comms`. Only the lifecycle agent and the onboarding procedure call the writing commands.

- `agent-home init <name>`: create a home from the template.
- `agent-home memory add|replace|remove <name> …`: edit `MEMORY.md` with the cap enforced; an add that overflows is refused until something is merged or removed in the same call.
- `agent-home apply <proposal-id> --file <f> --base <commit>`: write a change only if the file still matches the version that was reviewed; otherwise refuse, so the lifecycle agent reviews again.
- `agent-home build <name>`: assemble `AGENTS.md` within budgets, commit, and report the result to Convex (see 4).
- `agent-home check [<name>]`: report over-budget parts, task logs in memory, `PROGRESS.md` untouched for weeks, skills referenced but missing, stale skills. Read-only; agent health uses it.
- `agent-home archive <name>`: retire a home (moved, never deleted).

### 3. Review forks

- **A fork, never a resume.** The review runs in a new session copied from the agent's session; the agent's own thread is never written to and never interrupted. Claude Code: `claude --resume <session> --fork-session -p`, which starts a new session on the same prefix. T3 threads, Claude-LHC and Codex: Hazel's gate (G1) establishes how, or whether. **Fallback** where a harness can't fork: a fresh session given the agent's recent history as text (cold, but isolated).
- **Tools:** read-only (read, search) plus `comms propose`. No edits, no other commands.
- **Prompt:** a review skill adapted from Hermes's review prompts: what is worth keeping, where it belongs, what never to save, and to propose rather than write. Each proposal carries the evidence and a suggested destination.
- **Trigger:** a reminder per agent, run by the host's connector rather than delivered to an agent. New reminder options: `--action review-fork` (the connector launches the fork instead of sending a message) and `--min-turns <n>` (fire only once the agent has completed at least n turns since the last fire). Default: `--idle-for 2m --min-turns 10`, checked hourly. Firing soon after the agent goes idle keeps the fork on a warm cache where the provider allows.
- **Cost:** each fork's usage is recorded on its fire, so we can tune the cadence.

### 4. Convex

- **`machines`** gains `lifecycleAgent` and `healthAgent` (participant references). Shared files (`OWNER.md`, `PLATFORM.md`) belong to one host, lim-builder.
- **Registry** (participants) gains, reported by `agent-home build` (metadata only, no file content): home path, direction, skills (names), memory size against its cap, home commit, last build, last fork, last health check.
- **Turn counter:** each busy-to-idle transition increments a per-participant count, for `--min-turns`.
- **`proposals`:**
  - subject agent, host (stamped by the connector), kind (`memory`, `skill`, `role`, `soul`, `owner`, `platform`), proposed change, evidence, suggested destination, source fork session;
  - for a shared file, the file it targets, routed to that file's host;
  - state: `pending` → `reviewing` → `applied` | `declined` | `failed`, or `reviewing` → `needs-lee` → `approved` | `declined` → `applied` | `failed`. **`approved` and `applied` are separate:** a decision isn't a successful write;
  - decision note, reviewer, the base commit reviewed, the commit that applied it, timestamps;
  - indexed on (host, state).
- **Routing:** a new proposal sends a notice to its host's lifecycle agent; an hourly reminder sweeps anything missed. A move to another host re-queues the agent's pending proposals there, after the files move.
- **Lee's approvals:** `needs-lee` proposals appear in his approvals inbox; approving or declining wakes the lifecycle agent.
- **Rules:** `soul`, `owner` and `platform` proposals always go to `needs-lee` unless they record an instruction Lee gave directly; `memory`, `skill` and `role` proposals the lifecycle agent decides.
- **File reads for the web view:** on demand. The web view writes a short-lived file request; the host's connector answers it with the file's content; the request expires after 10 minutes. If the host doesn't answer within 10 seconds, the page says the host is offline. Convex never keeps home file content.

### 5. Local service and CLI

- `comms propose --kind … --evidence … [--target …] "change"`, accepted only from agents homed on this machine (a fork runs as its agent).
- `comms proposals [--pending] [--host]`, `comms proposal <id>`, `comms proposal start|apply|decline|escalate <id> [--note …] [--commit …]`, for the lifecycle agent.
- The connector runs `review-fork` reminder fires through the fork launcher, answers file requests, and reports builds.

### 6. The two maintenance agents (per host; lim-builder first)

- **Lifecycle:** onboarding and retiring agents (onboarding skill), integrating proposals (placement skill), applying changes with `agent-home`, a weekly skill curation (archive skills unused for 30 days, never delete).
- **Health:** an hourly sweep by reminder: stale presence, deliveries stuck `uncertain`, blocked reminders, forks not run, proposals stuck, `agent-home check` on every home, and `lhc-triage` on LHC agents (derivations complete, nothing odd in the rebuilt view). It diagnoses and helps unstick; it reports to the owner and never edits homes. Repairs to derived LHC state only once Lee grants that authority (the existing health charter).

### 7. Web view

- **Dashboard:** every agent by host, at a glance: presence, memory against cap, last fork, last health check, open proposals, open alerts.
- **Agent page:** soul, role and direction, skills, memory size; the files themselves on demand; proposal history.
- **Hosts:** each machine's connector status, lifecycle and health agents, queue depth.
- **Approvals:** every `needs-lee` proposal with the proposed change, evidence and the lifecycle agent's recommendation; approve, edit or decline.
- **Roundtables:** the existing groups, unchanged.

## Lanes

| Lane | Who | Work |
|---|---|---|
| Fork gate and launcher | Hazel | G1, then the launcher and the review skill |
| Convex and local service | Cedar | C0 contract, then Convex, commands, reminder options, file requests |
| `agent-home` and web | a new builder | the tool, then the web pages |
| Standards and skills | Reed, Wrenn, Alder | home template and shared files; onboarding, placement and health skills |

The third builder is onboarded by Reed at the start of the pass. `apps/web` moves from Hazel to the new builder; Cedar keeps every Convex function it calls.

## Plan

**In parallel, first:**
- **G1 (Hazel), the gate:** for Claude Code in a terminal, T3 Claude, T3 Claude-LHC and Codex: can we fork the session from outside, with the parent untouched, its own history, restricted tools, and a warm cache? Record how, with evidence. Build first for whichever passes.
- **C0 (Cedar), the contract:** proposal fields and states, routing, registry fields, file requests, the build report, the new reminder options, CLI JSON. Hazel and the new builder review before C1.
- **S0 (Reed):** the home template, `PLATFORM.md` and `OWNER.md` drafts (OWNER.md distilled from Reed's notes; Lee approves it once), and the placement skill.
- **S1 (Wrenn):** the onboarding skill. **S2 (Alder):** the health skill.

**Then:**
- **C1 (Cedar):** Convex and the commands.
- **A1 (new builder):** `agent-home`. **W1 (new builder, after C0):** the web pages.
- **F1 (Hazel, after G1 and C0):** the fork launcher, the review skill, and the `review-fork` reminder action with Cedar.

**Finish:**
- Onboard the lifecycle agent and the health agent for lim-builder using the onboarding skill.
- Migrate Cedar and Hazel to standard homes and run the full loop on them.

Rules as before: a failing test before each behaviour, a progress file per lane, raw evidence committed, a report to Reed by relay at each step.

## Acceptance (lim-builder; raw output in `validation/maintenance/`)

1. `agent-home build` refuses an over-budget part and an over-budget total; a valid build commits and the registry shows the new commit and memory size.
2. A review fork of Cedar runs while Cedar is working, files at least one proposal, and Cedar's thread shows nothing from it.
3. The lifecycle agent picks the proposal up from its notice, applies it with `agent-home`, rebuilds, and the proposal ends `applied` with its commit.
4. A proposal whose file changed after review is refused by `apply` and reviewed again.
5. A `soul` proposal goes to `needs-lee`; Lee approves it in the web view; it ends `applied`. A declined one ends `declined` with the note.
6. A proposal is routed to its host's lifecycle agent and no other.
7. The health sweep reports an over-budget memory, a stuck `uncertain` delivery and a fork that hasn't run, each once, and edits nothing.
8. The web view shows the dashboard, agent pages, hosts and approvals; a file opens on demand, and with the connector stopped the page says the host is offline.
9. The lifecycle and health agents were created by the onboarding skill, and their homes pass `agent-home check`.
10. Cedar and Hazel run on standard homes, and each has completed one fork, proposal and apply cycle.

## Not in this pass

Other hosts (the M5 joins with cloud Convex), LLM consolidation of skills, skill usage tracking, a librarian, work tracking, moving Reed, Wrenn and Alder over (that follows, using the lifecycle agent).
