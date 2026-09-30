# comms-stub

A stub connector for developing the Claude Code mod and the `comms` CLI. It serves the real [loopback protocol](../protocol/README.md) on the socket, over an in-memory comms record with the same rules the real server will have. No Convex.

What it does like the real connector: held polls (one per session), serial delivery per participant, `--as` accepted only for participants homed on its machine, retired recipients skipped and paused ones held, answers delivered but never collected, at most one collected answer per delivery, `comms reply` completing ambiguous deliveries, supersession of an older session, and restart checks instead of blind re-runs. What it doesn't: Convex, leases that expire, T3.

## Run

```sh
pnpm --filter @agent-comms/connector-stub start -- \
  --fixture packages/connector-stub/fixtures/dev.json \
  --socket /tmp/comms-dev/agent-comms/connector.sock \
  --state /tmp/comms-dev/state.json \
  --record /tmp/comms-dev/record.jsonl
```

- `--fixture`: participants (default home: this machine, `claude-code`, locator = name), conversations, and messages posted at startup. [`fixtures/dev.json`](fixtures/dev.json) has Lee, `cedar`, `hazel`, `mod-a`, `mod-b`, a T3 agent `reed`, `far` on another machine, a retired `old`, and a group `g_build` with a pending request to `mod-a`.
- `--state`: persist the record; on restart, load it instead of the fixture. Sessions aren't persisted, so a restarted stub behaves like a restarted connector: polls answer `unknown_session`, the client registers again, and anything unfinished comes back as a check.
- `--record`: every request and response as JSON lines.
- `--socket`: default `$AGENT_COMMS_SOCKET`, else the per-user path. The parent of the socket's directory must exist; the directory itself is created 0700.

Run it in a memory-capped unit on lim-builder, e.g. `scripts/capped.sh --mem 512M node packages/connector-stub/src/main.ts …`.

## Drive it

The mod and the CLI use it as they'll use the real connector. Point them at the socket with `AGENT_COMMS_SOCKET`. To play the other side:

```sh
S=/tmp/comms-dev/agent-comms/connector.sock
export AGENT_COMMS_SOCKET=$S

# Post as anyone homed here (lee is homed here in the dev fixture):
comms send --as lee --conversation g_build @mod-a "mod-a: what's 2+2?"
comms send --as mod-b @mod-a "a DM request"

# Act as a mod by hand. Deliveries come one at a time, oldest first: d_1 is the fixture's request.
curl -s --unix-socket $S localhost/v1/register -d '{"participant":"mod-a","harness":"claude-code","sessionId":"s1","cwd":"/tmp","status":"idle"}'
curl -s --unix-socket $S localhost/v1/poll -d '{"sessionId":"s1","waitMs":5000}'
curl -s --unix-socket $S localhost/v1/delivered -d '{"sessionId":"s1","deliveryId":"d_1","turnId":"t1"}'
curl -s --unix-socket $S localhost/v1/outcome -d '{"sessionId":"s1","deliveryId":"d_1","turnId":"t1","outcome":"replied","answer":"OK"}'
comms read --as lee g_build   # the answer is #4, linked to m_2
```

Stub-only controls, on the same socket:

| Request | Does |
|---|---|
| `GET /stub/state` | the whole record plus live sessions |
| `POST /stub/post` `{sender, to[], conversationId?, text, kind?, inReplyTo?, via?}` | posts as any participant, including ones homed elsewhere |
| `POST /stub/check` `{deliveryId}` | queues a restart check for a claimed or delivered delivery on its recipient's current session |

## Tests

`pnpm --filter @agent-comms/connector-stub test` (in a capped unit: `scripts/capped.sh pnpm -r test`).
