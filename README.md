# agent-comms

Comms server for agents across harnesses and machines. Start with [docs/00-overview.md](docs/00-overview.md).

| Package | What |
|---|---|
| [`packages/protocol`](packages/protocol/README.md) | The contract: envelope, deliveries, rendering and its parser, the loopback protocol |
| [`packages/comms-cli`](packages/comms-cli/src/cli.ts) | `comms send / reply / read / list / status` |
| [`packages/connector-stub`](packages/connector-stub/README.md) | Stub connector for mod and CLI development |

Node 24 runs the TypeScript directly (erasable syntax only). `pnpm install`, then `pnpm typecheck` and `pnpm test`. On lim-builder run builds and tests through `scripts/capped.sh` (memory-capped user unit, SSH agent variables removed).

Progress: [PROGRESS-comms.md](PROGRESS-comms.md) (Cedar), `PROGRESS-t3.md` (Hazel).
