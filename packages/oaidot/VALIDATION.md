# oaidot validation

Local validation on 2026-10-06, Node 24.19.0 and pnpm 11.19.0.

## Passed

- Whole-workspace TypeScript checks, including Convex
- Protocol: 68 tests
- Convex: 162 tests across 14 files, including 19 oaidot lifecycle tests
- Shared receive holder: 13 socket-free tests against real `convex-test` functions
- oaidot package: 20 tests (9 client, 3 stdout, 8 stdio)
- Six of the stdio cases use an actual subprocess and the production native
  transport, receive holder, client and stdio host, with a fake subscription backend
- Release build: `pnpm build:release 0.0.0-oaidot-check`
- Release helper tests: 4 tests
- CI helper tests: 12 tests
- Git whitespace/diff checks

The stdio tests cover delayed subscription events, no implicit ACK/reply,
explicit receipt and reply, duplicate acknowledgement and idempotent reply,
expiry/reoffer and stale-claim rejection, cancellation/EOF cleanup, bounded
input and concurrent requests, identity spoof rejection, sanitized failures,
and slow/closed output consumers. The one-shot fixture exits on one delayed
offer without waiting for stdin, leaving acknowledgement and reply counts at zero.

Independent review found and verified fixes for parent locator binding across
same-machine rebind, retired-agent recovery, recovery pagination, stdout
backpressure and deferred write errors, and native scope cleanup on startup
failure.

## Actual parent wake, fake backend

### Recommended one-event route: passed without log polling

The production client and shared receive holder ran against the local fake
subscription backend using the one-event fixture:

```sh
node packages/oaidot/test/fixtures/stdio-host.ts --once --delay-ms 15000 --text dot-one-event-wake-20261006T2210Z
```

Observed on 2026-10-06 (UTC):

- Fixture started at 22:10:11.969970059
- Actual parent began waiting at 22:10:16
- The offer was claimed at approximately 22:10:27.545, inferred from its fixture lease
- Command completed at 22:10:27.605767617, exit 0
- Native relay woke the actual parent at approximately 22:10:34
- One subscription, one receive, one unsubscribe; zero acknowledgements, replies,
  sends, heartbeats or participant-presence changes

The courier obtained the offer directly from one blocking wait for command
completion. There were no logfile reads, inbox polls or external service calls.
This verifies the recommended package-to-native-worker-to-actual-parent wake
route within the live session. These are observations from one run, not a
latency guarantee.

### Explicit receipt/reply path

An earlier fixture containing `dot-package-wake-20261006T2204Z` also woke the
actual parent, which then explicitly authorized the exact receipt and reply:

- Before parent acknowledgement: `claimed`, one receive, zero acknowledgements,
  zero replies
- After explicit parent acknowledgement and reply: `replied`, one acknowledgement,
  one reply, zero sends
- Stdin close: process exit 0 and exactly one subscription cleanup

That earlier persistent-stdio run required one inspection of buffered output;
it established explicit receipt/reply behavior, not uninterrupted wake latency.
The later one-event run above established wake without that inspection step.

Both tests used a fake backend in an active native-worker/parent session. They
do not prove production Convex connectivity, live peer delivery, persistence
across session termination, or durable 24/7 availability.

## Environment-limited checks

`pnpm check` was run. Typechecking and earlier checks passed, but the existing
connector-stub tests fail while binding Unix sockets in this cloud workspace:
`listen EPERM: operation not permitted .../connector.sock`. An escalated retry
of the new loopback tests produced the same runtime error. Ten new real-loopback
tests are retained for a socket-capable environment and were not validated here.
The socket-free stdio path was tested instead; no socket/security settings changed.

Production deployment, credentials, participant enrollment, a live Convex/peer
round trip, and Windows execution were not performed. No deployment or credential changes
were part of this validation.
