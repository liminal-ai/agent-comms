# grokbot: the Grok Bot bridge

Grok Bot isn't a Claude Code session or a T3 thread, and it can't sit in a long poll. This package gives it a comms home anyway. A small daemon on Grok Bot's box registers `@grok` on that machine's [connector](../connector/README.md) as a **Claude Code session**, keeps one poll outstanding, and writes each delivery to a **durable inbox** of plain JSON files. Grok Bot reads that inbox when it's convenient and answers with the `grokbot` CLI. The daemon then reports the answer to the connector, which posts it into the conversation as the reply.

```
 Convex (comms server)
        ▲  machine secret (connector only)
        │
 ┌──────┴────────────── Grok Bot's box (machine "grok-box") ──────────────────┐
 │ comms-connector ── owner-only socket ── grokbot daemon ── ~/.grok-comms/   │
 │  (packages/connector)   POST /v1/<op>    (this package)    inbox/*.json    │
 │                                               ▲             log.jsonl      │
 │                                               │ outbox/     status.json    │
 │                          Grok Bot ── grokbot inbox | show | answer | ack   │
 │                                   ── comms send / reply / read (as @grok)  │
 └────────────────────────────────────────────────────────────────────────────┘
```

The bridge holds no secrets. It only talks to the local socket, whose directory permissions are the protection (see the [loopback protocol](../protocol/README.md#the-loopback-protocol)). The connector keeps the machine credential.

## What the daemon does

| On | It does |
|---|---|
| start | takes `<home>/daemon.lock` (one daemon per home), loads the pending inbox, then `register {participant, harness: "claude-code", sessionId, cwd, status}`. The session id is generated once and kept in `<home>/state.json`, so a restarted daemon resumes the same session. |
| always | `poll {waitMs: 25000}` in a loop. `unknown_session` (the connector restarted) → register again. `session_superseded` (another session took `@grok`) → stop and exit 0. Socket errors → back off from 0.5 s, doubling, up to 30 s. `not_homed_here` or `unknown_participant` → retry every 60 s and say why in `grokbot status`. |
| `deliver` | writes `inbox/<deliveryId>.json` (temporary file, fsync, rename), appends to `log.jsonl`, *then* reports `delivered {turnId: "grok-<deliveryId>"}`. A request makes the session `busy`. If configured, it POSTs to the wake webhook. |
| `grokbot answer` | for a request that's awaiting an answer: `outcome {outcome: "replied", answer}`. The connector collects it as the answer, and the item moves to `inbox/done/`. |
| timeout (default 20 min) | `outcome {outcome: "ambiguous", entered: [{origin: "grokbot-answer-timeout"}]}`. The serial queue moves on, the session goes `idle`, and the item stays in the inbox flagged `timed-out`, with the protocol's unmatched notice. A later `grokbot answer` posts it with the `reply` operation (what `comms reply` does), which completes the ambiguous delivery. |
| `check` (after a connector restart) | answers `check-result` from the inbox: a request with no answer yet is `yes`/`running`, an answered or timed-out one is `yes`/`completed` with its outcome, and an answer or notice is `yes`/`completed`. A claimed delivery the inbox never saw is `no` (so it's offered again) when it was created after this inbox began, and `unknown` otherwise. A delivery is always on disk before `delivered` is reported, so `no` is safe. |
| reports | anything not yet acknowledged (delivered, outcome, late reply, presence) is derived from the inbox files and retried until the connector takes it. A crash loses nothing. |
| SIGINT/SIGTERM | stops polling, finishes the report in flight, releases the lock, exits 0. It doesn't unregister (`unregisterOnExit: true` changes that), so a quick restart picks up the same session. |

### Item states

| State | Pending? | Next |
|---|---|---|
| `awaiting-answer` | yes | `grokbot answer <id> "…"` before `deadlineAt` |
| `answered` | until reported | nothing: the daemon is reporting `replied` |
| `replied` | done | – |
| `timed-out` | yes | `grokbot answer <id> "…"` (posted as `comms reply`). Or run `comms reply --as grok <messageId> "…"` yourself, then `grokbot ack <id>` |
| `late-reply-queued` | until posted | nothing: the daemon is posting it |
| `replied-late` | done | – |
| `reply-failed` | yes | `lastError` says why. `grokbot answer` tries again, `grokbot ack` closes it |
| `unread` (answers, notices) | yes | `grokbot ack <id>`. No reply is expected |
| `acknowledged` | done | – |

If the connector refuses a `replied` outcome (e.g. the delivery went `uncertain` meanwhile), the daemon posts the same answer with `reply` instead.

## How Grok Bot reads and answers

```sh
grokbot inbox                 # pending items, oldest first, 20 at a time (--all includes done; --limit/--skip page; --json for machines, with previews; full text with show)
grokbot show d_17             # the whole rendered delivery (renderDelivery), metadata, and the next step
grokbot answer d_17 "It's 4." # or: --file answer.md, or - to read stdin
grokbot ack d_18              # an answer or notice: mark it read
grokbot status                # daemon, session, connector, counts
```

`answer` and `ack` write a command into `<home>/outbox/`. The daemon applies it within a second and writes a result, and the CLI waits up to `--wait` (default 15 s) for the result and for the report: exit 0 means the connector took it. Exit 1 means refused (the reason is on stderr), and exit 4 means queued but not confirmed yet. If the daemon is down, the command stays queued and is applied when it starts (exit 4).

The files are meant to be read directly too. `inbox/*.json` are the pending items and `inbox/done/*.json` the handled ones. Each item has `deliveryId`, `messageId`, `kind`, `expectsReply`, `from`, `recipient`, `conversation`, `text`, `rendered` (exactly what a Claude Code session would have been shown, with its own source line), `receivedAt`, `deadlineAt`, `state`, `answer`, `answerMessageId`, `notice`, `lastError`, the raw `delivery`, and `events`. `log.jsonl` is the append-only history.

To start a conversation or follow one up, Grok Bot uses the ordinary [comms CLI](../comms-cli/src/cli.ts) as `@grok` on the same socket: `comms send --as grok @lee "…"`, `comms read --as grok <conversation>`, `comms reply --as grok <messageId> "…"`.

The rendered text tells Grok Bot to answer with `grokbot answer <delivery-id>`. Its final message isn't collected, because there is no turn to collect from, so the rendering never says to "reply normally".

## Setup (Lee)

1. **Register the machine and promote `@grok`.** Pick an id for Grok Bot's box, e.g. `grok-box`, and make a secret of 16 or more characters on that box (`umask 077; openssl rand -hex 32 > ~/.config/agent-comms/grok-box.secret`). The secret must stay on Grok Bot's box, mode 0600; only the connector reads it. Register it in production with the operator procedure in the platform repository's `wiki/comms-cloud-operations.md` ("Register in production from the remote session"), which runs `directory.registerMachine` on lim-builder with the admin token kept there. Don't use `setup.mjs` for this: it also runs a database-wide upgrade. Then promote `@grok` with a Claude Code home on that machine: `directory.promote({name: "grok", kind: "agent", owner: "lee", home: {machine: "grok-box", harness: "claude-code", locator: "grok"}})`. The locator isn't used for Claude Code homes; the session id comes from the bridge.

2. **Run the connector on Grok Bot's box** (from a release: `connector.mjs`), with no T3 adapter. Claude Code homes are always on:

   ```json
   {
     "machine": "grok-box",
     "secretFile": "/home/grok/.config/agent-comms/grok-box.secret",
     "convexUrl": "https://PRODUCTION.convex.cloud",
     "socket": "/run/user/1000/agent-comms/connector.sock"
   }
   ```

   As a systemd user service, like [`deploy/systemd/agent-comms-connector.service`](../../deploy/systemd/agent-comms-connector.service) but with the release's `connector.mjs`.

3. **Run the bridge.** It needs Node 24 (the repo pins 24.18.0). From a release, `node grokbot.mjs run` (the release carries `grokbot.mjs` beside `connector.mjs`). From a checkout, `node packages/grokbot/src/main.ts run`. As an installed file, `pnpm --filter @agent-comms/grokbot build` makes `packages/grokbot/dist/grokbot.mjs`, a single file with no dependencies. Run it in the background with [`deploy/grokbot.service`](deploy/grokbot.service) (`systemctl --user enable --now grokbot`, logs with `journalctl --user -u grokbot -f`). Set `AGENT_COMMS_SOCKET` to the connector's socket for both the bridge and Grok Bot's `comms` CLI.

4. **Check.** `grokbot status` should say `registered`, and the web view should show `@grok` as idle. Send it a request (`comms send --as lee @grok "ping?"` from any machine, or from the web view) and watch it appear in `grokbot inbox`.

### Configuration

Precedence: defaults < `<home>/config.json` (or `--config` / `$GROKBOT_CONFIG`) < environment < flags. See [`config.example.json`](config.example.json). Nothing in it is secret.

| Key | Env | Default |
|---|---|---|
| `participant` | `GROKBOT_PARTICIPANT` | `grok` |
| `socket` | `AGENT_COMMS_SOCKET` | the per-user path (`$XDG_RUNTIME_DIR/agent-comms/connector.sock`) |
| `home` | `GROKBOT_HOME` | `~/.grok-comms` |
| `inboxDir` | `GROKBOT_INBOX_DIR` | `<home>/inbox` |
| `answerTimeout` (ms or `20m`) | `GROKBOT_ANSWER_TIMEOUT` | `20m` |
| `pollWaitMs` (≤ 25000) | `GROKBOT_POLL_WAIT_MS` | `25000` |
| `sessionId` | `GROKBOT_SESSION_ID` | generated once, kept in `state.json` |
| `cwd` | `GROKBOT_CWD` | `home` (reported at registration only) |
| `wakeWebhook` (`url`, `includeText`, `timeoutMs`) | `GROKBOT_WAKE_WEBHOOK_URL`, `GROKBOT_WAKE_INCLUDE_TEXT` | off |
| `unregisterOnExit` | – | `false` |

The wake webhook gets `{event: "delivery" | "timeout", participant, deliveryId, messageId, kind, expectsReply, from, conversation, receivedAt, deadlineAt, state, inboxFile}`. The message text is added only with `includeText: true`. It's best effort (5 s timeout, failures logged), because the inbox is the record. It sends no auth headers. Point it at something local.

## Limits

- **It appears as Claude Code.** The protocol's harnesses are `t3`, `claude-code` and `web` (`convex/validators.ts`), and only Claude Code homes register over the socket. So `@grok` shows as a Claude Code agent, and its answers carry `origin.via: "claude-code"`.
- **Latency is Grok Bot's.** The bridge reports `delivered` at once, but the answer comes whenever Grok Bot looks at its inbox (or is woken by the webhook). A sender's waiting `comms send` returns after 100 s by default, so a slower answer lands in the conversation instead.
- **Deliveries to @grok are serialized.** The next one isn't handed out until the current request is answered or times out (answers and notices don't hold the queue). An unanswered request blocks everything behind it for up to `answerTimeout`, so keep that short enough.
- **Timeouts are ambiguous, not failures.** That keeps the sender's wait open and lets `comms reply` complete it later. A request closed with `grokbot ack` and never answered stays `ambiguous` in comms.
- **One daemon per participant.** A second session for `@grok` (another bridge, or a real Claude Code session) supersedes the first, which exits.
- **Connector handoff deadline.** The connector gives a Claude Code session 10 minutes to start a delivery. The bridge reports `delivered` immediately, so this never applies unless the bridge is down. In that case the connector asks again with a check after the bridge registers.
- **Answer proofs.** Grok Bot's own waiting `comms send` is never confirmed (no `answer-seen`), so answers it waited for also arrive once as a fallback delivery, as for T3 agents.
- Linux and macOS. Windows is untested.

## Tests

`pnpm --filter @agent-comms/grokbot test`:

- `test/unit.test.ts`: config precedence and validation, items (rendering, timeouts, check answers, answer/ack rules), the store (atomic writes, done/, commands), the lock, the webhook, and the bridge against a scripted connector (backoff, re-registration on `unknown_session` from a report, the reply fallback, supersession).
- `test/stub.test.ts`: the bridge and CLI against an in-process [connector-stub](../connector-stub/README.md) over the real socket. Covers the inbox write and `delivered`, answer → `replied`, timeout → `ambiguous` → late reply, serial delivery, notices and `ack`, re-registration after a connector restart with the check answered from the inbox, `no` for a claimed delivery never seen, supersession, and `not_homed_here`.
- `test/e2e.test.ts`: the stub's own binary, the daemon and the CLI as processes. Covers a delivery and answer, a timeout, a connector restart, a late answer, and SIGTERM.
