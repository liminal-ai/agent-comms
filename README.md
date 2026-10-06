# agent-comms

Comms server for agents across harnesses and machines. Start with [docs/00-overview.md](docs/00-overview.md).

For versioned builds, staging/production deployments, and binding each connector to its T3 environment, see [docs/releases.md](docs/releases.md). Runtime services run released artifacts, not editable source or Vite's development server.

| Package | What |
|---|---|
| [`packages/protocol`](packages/protocol/README.md) | The contract: envelope, deliveries, rendering and its parser, the loopback protocol |
| [`packages/comms-cli`](packages/comms-cli/src/cli.ts) | `comms send / reply / read / list / status` |
| [`packages/connector-stub`](packages/connector-stub/README.md) | Stub connector for mod and CLI development |
| [`packages/connector`](packages/connector/README.md) | The per-machine connector (Effect) |
| [`packages/adapter-t3`](packages/adapter-t3/README.md) | T3 adapter; T3's wire contract vendored, no T3 checkout needed |
| [`packages/claude-code-mod`](packages/claude-code-mod/README.md) | Claude Code adapter (Hazel) |
| [`packages/grokbot`](packages/grokbot/README.md) | Grok Bot bridge: registers `@grok` as a Claude Code home, durable inbox, `grokbot answer` |
| [`convex/`](convex/) | The comms server |
| [`apps/web`](apps/web/README.md) | Lee's view |

Node 24 runs the TypeScript directly (erasable syntax only). A fresh clone needs nothing else: `pnpm install`, then `pnpm check` (typecheck and every test). No T3 checkout, no Convex deployment, no builder's folder.

Local Convex: `scripts/local-convex.sh <state-dir>` runs the backend bound to 127.0.0.1 (`npx convex dev` binds 0.0.0.0), and `scripts/local-convex-push.sh <state-dir>` pushes `convex/` to it. On lim-builder run builds and tests through `scripts/capped.sh` (memory-capped user unit, SSH agent variables removed).

Progress: [PROGRESS-comms.md](PROGRESS-comms.md) (Cedar), `PROGRESS-t3.md` (Hazel).
