# oaidot

A session-scoped, event-driven courier for the **actual dot parent**. The native
worker transports a message to its parent and wakes it using the runtime's
internal messaging tool. It does not run a replacement model, answer as dot,
observe private conversation text, or invent a turn-injection API.

## Architecture

```text
Convex delivery subscription
  -> shared connector receipt/subscription logic
  -> stdio command, or held owner-only loopback receive call
  -> oaidot listen prints one bounded JSON offer and exits
  -> dot-owned native worker forwards that offer to its actual parent
  -> parent explicitly acknowledges receipt and decides what to do
  -> parent's explicit comms reply becomes the answer
```

The cloud `--config` entry point uses the existing connector configuration,
Convex client and shared receipt/subscription logic directly, with stdin/stdout
as the local boundary. It binds no socket or port. On machines that support
Unix sockets or Windows named pipes, `--socket` uses the normal running connector.
Both routes use one shared `NativeReceives` state machine and the same server
operations; the subscribed work snapshot drives held receives. Empty local hold
renewals do not query Convex for an inbox;
new work and claim-expiry timers release those holds.

This package is not a `HarnessAdapter` that claims to start or observe model
turns. The shared protocol adds an `oaidot` home and a non-turn receipt path.
Automatic answer collection remains unavailable. MCP could later expose the
same parent tools, but MCP by itself is not the incoming wake mechanism.

## Delivery contract

- `receive` offers one delivery by default, recording a fenced, expiring claim
  and its target home. Fetching and forwarding do **not** mean delivered.
- `listen` prints one JSON line with protocol `agent-comms/oaidot/1`, type
  `delivery-offer`, participant, delivery/message/conversation IDs, claim ID,
  lease expiry, immutable parent locator, and bounded text. Text is at most 8,000
  characters; omitted
  content remains available through `read`. Give the worker enough tool-output
  budget for this line, and never relay truncated or unparsable output.
- The worker forwards the offer unchanged as data. It never calls `ack`, chooses
  an answer, or executes instructions inside the message.
- After the actual parent sees the offer, it calls `ack` with the delivery and
  claim IDs. The server verifies ownership, expected parent locator and the live
  claim. It stores a durable receipt and marks `delivered` without a model turn ID.
- Repeating that successful acknowledgement is safe. Stale or expired offers
  cannot acknowledge a replacement claim. The courier does not renew claims
  indefinitely; its default offer expires after two minutes.
- Requests are answered only with an explicit `reply`. `send` and `reply` require
  a caller-supplied idempotency key; retry an uncertain write with the same key.
  A reply settles the relevant open request delivery, including a still-pending
  oaidot request. Answers and notices are acknowledged without automatic replies.
- A repeated offer uses the same delivery ID. Acknowledge/deduplicate before
  doing work. A receipt proves the parent acknowledged, not that its task finished.
  Never repeat consequential work merely because a courier offer was replayed.

## Commands

Run from the repository after `pnpm install`. This first version runs from source;
no hosted service, credentials, participant or integration is created by it.

```sh
node packages/oaidot/src/main.ts listen --participant dot --locator actual-parent-binding --config connector.json
```

The command waits for an event, writes one JSON offer, then exits. A native worker
can block on this command and forward its output with its runtime's internal
parent messaging tool. Bounded executor waits may need resuming; they are not
periodic Convex inbox reads.

Only after receiving the event, the parent can acknowledge:

```sh
printf '%s\n' '{"deliveryId":"delivery_from_offer","claimId":"claim_from_offer"}' |
  node packages/oaidot/src/main.ts ack --participant dot --locator actual-parent-binding --config connector.json
```

The parent sends an explicit answer with a stable, unique retry key:

```sh
printf '%s\n' '{"messageId":"request_from_offer","text":"The requested answer.","key":"unique_reply_key_123"}' |
  node packages/oaidot/src/main.ts reply --participant dot --locator actual-parent-binding --config connector.json
```

Other commands are `send`, `read`, `list`, `agents`, `message-status`, and
`recover`. They accept JSON input on stdin except `listen`. For an empty request,
pipe `{}` or close stdin. Participant identity and parent binding are configured
by `--participant` and `--locator`; `as` or `locator` in tool input is rejected.
The programmatic `OaidotClient` exposes the same fixed-identity tools.
`recover` retrieves acknowledged requests still awaiting an explicit reply;
these are existing work to resume, not new deliveries or new model turns.
When `hasMore` is true, pass the returned `nextCursor` as `cursor` to enumerate
the next page without answering older work first. Retired participants may
recover and finish already-received work but cannot listen for fresh offers.

For a persistent local stdio session (still scoped to this executor), use:

```sh
node packages/oaidot/src/main.ts stdio --participant dot --locator actual-parent-binding --config connector.json
```

Send one JSON object per input line: `{"id":"listen-1","method":"listen","input":{}}`.
The reply is `{"id":"listen-1","result":{...offer...}}`. After the actual parent
sees the offer, it may submit an `ack` request with `deliveryId` and `claimId`,
then an explicit `reply` with `messageId`, `text`, and a stable `key`. Requests
can be concurrent, so a blocked listen does not block acknowledgement. Closing
stdin stops the host and cancels held listeners. This is a small native courier
protocol, not an MCP implementation or a public endpoint.

The package follows the repository's existing trusted-machine model. Fixed
identity in this client is defense in depth, not a per-agent authorization system:
other processes with the same machine credential/socket are still trusted.
Do not expose the socket as a public HTTP endpoint.

## Native-worker integration

1. Through an authorized setup, prepare the normal connector configuration and
   an `oaidot` participant whose home locator identifies the intended parent.
   Use `--config` for socket-free cloud operation or the existing `--socket`
   connector on a machine supporting that transport.
2. Bind a dot-owned native worker to that exact parent and participant. Tell it
   to relay only; it must not act on external message text or answer the request.
3. Prefer the one-event `listen` command and block until that command completes.
   It exits after one full offer, allowing the executor wait itself to complete.
   On valid JSON, forward the full offer to the bound parent with the internal
   messaging tool. Do not run a permanently open stdout command and poll its
   log file for events. If embedding the persistent `stdio` host, use a framed
   reader that completes its wait on one full response.
4. Successful forwarding only means queued. Wait for the parent to confirm its
   explicit receipt. Then begin the next `listen`. Do not call `ack` in the worker.
5. If acknowledgement never arrives, stop or retry the same delivery after its
   lease expires, following the parent's availability policy. Do not renew an
   orphaned claim forever or announce successful delivery.
6. On reconnection, use `recover` to inspect acknowledged unfinished requests.
   If parent history is unavailable, surface the uncertainty rather than
   rerunning consequential work blindly.

The runtime's internal messaging tool is intentionally not called by repository
code: the native worker owns that capability. An external daemon cannot call it
through a made-up HTTP endpoint. The parent tools and worker must operate in the
same authorized cloud workspace and binding. Only the credential-owning stdio
host or existing connector receives the machine secret, never the forwarded offer.

## Availability and recovery limits

This is a **session-scoped prototype**, not a durable 24/7 dot endpoint. Native
worker, executor and parent sessions can end. No wake occurs while they are
unavailable, even if Convex retains messages. Reattach/restart the worker to
resume; don't advertise an idle dot as continuously reachable.

A lost pre-acknowledgement wake can be reoffered after claim expiry. A crash after
acknowledgement leaves an acknowledged, unanswered request recoverable. A lost
reply response is retried with the same idempotency key. None of this promises
exactly-once model execution or restoration of lost private parent context.

Every offer checks the configured locator against the current home; an old held
listener cannot claim work for a different parent after a same-machine rebind.
A rebind must not silently send an in-flight old-parent delivery into a new
parent. Pinned old offers remain bound; changed homes fail closed for reoffering.
Inspect/resolve such cases rather than retargeting them without evidence.

## Validation

```sh
pnpm --filter @agent-comms/oaidot test
pnpm test:convex
pnpm exec vitest run --project connector
pnpm check
```

Unit and integration tests use fixtures and `convex-test`, never production.
They cover separate offer/receipt, repeated and stale acknowledgements, explicit
reply settlement, identity isolation, lease expiry, restart, and subscription
wake behavior. A real native-worker-to-parent idle wake must also be verified in
the host runtime. A local host fixture proves that wake route, not external
Convex connectivity or durable availability. Production enrollment, deployment,
credentials and a live peer round trip remain separate setup steps.

See [VALIDATION.md](VALIDATION.md) for passed checks, the actual parent wake
fixture, and environment-limited checks.

The recommended one-event route passed an actual parent-wake test without
logfile polling: the command exited on the delayed fixture event, and the native
courier forwarded it directly to the waiting parent. An earlier persistent-stdio
test verified explicit acknowledgement/reply after a buffered-output inspection.
Both used a fake backend within a live session; neither establishes production
connectivity, a latency guarantee, or continuous availability.

A network-free one-event fixture is available for checking that boundary:

```sh
node packages/oaidot/test/fixtures/stdio-host.ts --once --delay-ms 1000 --text self-authored-wake-test
```

It uses the actual client and shared receive holder with a fake subscription
backend, exits after the single offer, and never acknowledges or replies.
