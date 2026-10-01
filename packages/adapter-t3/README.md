# adapter-t3

The T3 adapter: delivers comms messages into T3 threads and collects their answers, matched from T3's own event stream. Loaded by the connector when its config lists `"adapters": ["t3"]` with a `t3` section (`baseUrl`, `authFile` holding a T3 bearer, mode 0600).

## How it talks to T3 (no T3 checkout needed)

The few pieces of T3's wire contract it uses are vendored in [`src/t3/wire.ts`](src/t3/wire.ts), taken from **T3 v0.0.44 (tag `v0.0.44`, commit `451afcb22d93f06cb24f9bc16703404564952553`)**:

- `GET /api/orchestration/threads/:id` (snapshot), `POST /api/orchestration/dispatch` (`thread.turn.start`), `POST /api/auth/websocket-ticket`: plain HTTP with the bearer.
- `orchestration.subscribeThread` over the WebSocket: Effect RPC with JSON serialization, called through this repo's own `effect` (the same `4.0.0-rc.115` T3 pins). The RPC is declared with loose success/error schemas and only the fields the adapter reads are narrowed by hand, so extra fields from T3 don't break it.

We chose vendoring over depending on a T3 checkout or T3's `client-runtime` package: those move with T3, pull in its whole Effect tree, and tied the build to one builder's folder. When T3 is upgraded, re-check `wire.ts` against its `packages/contracts/src` (`orchestration.ts`, `rpc.ts`, `auth.ts`, `environmentHttp.ts`) and update the recorded version.

Behavior notes from live runs are in `docs/t3-api-notes.md` and `validation/m3/`.
