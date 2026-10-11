# comms-connector

One per machine. Subscribes to the deliveries for participants homed here, claims them, hands them to the right harness adapter, and writes back what happened. Serves the [loopback protocol](../protocol/README.md) on the owner-only socket for the mod and the `comms` CLI. Effect `4.0.0-rc.115`, matching T3 v0.0.44.

| File | What |
|---|---|
| `server-api.ts` | The Convex functions in `convex/connector.ts`, with errors sorted into protocol refusals and unavailability |
| `dispatcher.ts` | Claims, leases, the pre-handoff compare-and-set, serial per participant, restart recovery, retried writes |
| `adapter.ts` | The adapter interface: `ready`, `handOff`, `awaitOutcome`, `check` |
| `claude-code.ts` | Mod sessions (register, held polls, reports) and the Claude Code adapter |
| `claude-cloud.ts` | Posts deliveries through the local Claude Code CLI to cloud sessions; replies come by `comms reply` |
| `loopback.ts` | The HTTP server on the socket |
| `connector.ts`, `main.ts`, `config.ts` | Wiring and the `comms-connector` entry point |

## Guarantees, as built

- **Claims.** A delivery is claimed with a lease (default 60 s), renewed every third of it while working, and renewed once more immediately before the handoff. If that compare-and-set fails, nothing is handed over.
- **Nothing runs blind.** A delivery found `claimed` or `delivered` that this process isn't working on is recovered through the adapter's check once the lease has expired (or at once if it's our own claim): absent and never delivered → run it; running → keep watching; finished → record the outcome; can't tell → `uncertain`.
- **Only what can be handed over is claimed.** A Claude Code participant's deliveries wait as `pending` until its session is registered and polling.
- **Serial per participant**, parallel across participants.
- **Never on a harness's path.** Reports from the mod are acknowledged immediately; writes retry with backoff (to 30 s) while the server is unreachable. CLI calls (`send`, `reply`, `read`, `list`) go straight through and answer `unavailable` if the server doesn't answer in 10 s.
- **Not promised:** a report the connector acknowledged but hadn't yet written when it crashed. The restart check recovers delivered/outcome state from the session; that's the accepted limit.

## Run

Config (JSON):

```json
{
  "machine": "lim-builder",
  "secretFile": "~/.config/agent-comms/lim-builder.secret",
  "convexUrl": "http://127.0.0.1:3240",
  "leaseMs": 60000,
  "pollWaitMs": 20000
}
```

`socket` defaults to the per-user path. The secret file must be mode 0600; register it once with `scripts/dev-setup.ts` (which also promotes participants from a seed file).

`adapters` optionally lists `"t3"` and/or `"claude-cloud"`; the Claude Code terminal adapter is always loaded. T3 requires its `t3` config section. Enable Claude cloud with `"adapters": ["claude-cloud"]` and optionally `"claudeCloud": { "bin": "/path/to/claude" }` (default: `claude` on PATH). These options also work in a local-mode service config.

A `claude-cloud` home uses `session_<alphanumeric id>` or `https://claude.ai/code/session_<alphanumeric id>` (optionally with a query string) as its locator. The already-authenticated local CLI posts each rendered delivery with `claude -p --cloud <locator> --output-format json`, receiving the prompt on stdin, with a 120-second timeout and no shell. On Windows, `claudeCloud.bin` must point at the native executable; `.cmd`/`.bat` shims are unsupported. Binary availability is reported as `idle`/`offline`; the adapter cannot observe the cloud session's activity.

A successful receipt makes a request `ambiguous` immediately and releases the participant for its next delivery. The cloud session answers later with `comms reply --as <name> <messageId> "<answer>"`; its final message is never collected. Only an explicit `ok:false` receipt or a definite pre-spawn refusal makes a delivery `failed`. Other post-spawn non-success results may already have posted: recovery records `uncertain`, never resends blind, and allows a later `comms reply` to settle the request. This adapter does not provision or authenticate sessions.

```sh
scripts/capped.sh --mem 512M node packages/connector/src/main.ts --config connector.json
```

## Tests

`vitest run --project connector` (from the repo root, in a capped unit): the real Convex functions through convex-test, the real loopback socket, and a scripted mod. Covers the round trip, answers never collected, no claim without a session, serial delivery, ambiguous + `comms reply`, CLI pass-through and `unavailable`, session supersession, restart recovery (delivered turn, claimed-but-absent re-run, unknown → uncertain), and writes retried through an outage.
