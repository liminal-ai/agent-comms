# Running agent-comms on a machine (lim-builder)

> Historical source-checkout deployment instructions. Current production/staging run versioned artifacts with Convex cloud; use [released environments](../docs/releases.md) and the [platform machine record](https://github.com/liminal-ai/platform/blob/main/machines/lim-builder.md). Keep the recovery/migration history below as reference, not as the current install procedure.

Two `systemd --user` services, both running `main` from `/srv/work/agent-comms`. Nothing they read lives in a builder's or agent's home folder.

| What | Where |
|---|---|
| `agent-comms-convex.service` | local Convex backend, bound to 127.0.0.1:3240 (site 3241), via `scripts/local-convex.sh` |
| `agent-comms-connector.service` | the connector, socket `$XDG_RUNTIME_DIR/agent-comms/connector.sock` |
| `~/.local/share/agent-comms/convex/` | the backend's state: `config.json` (admin key, instance secret; 0600), sqlite, storage |
| `~/.config/agent-comms/connector.json` | connector config (no secrets in it) |
| `~/.config/agent-comms/lim-builder.secret` | the machine's connector secret (0600) |
| `~/.config/agent-comms/admin-token` | the web view's dev admin token (0600) |
| `~/.config/agent-comms/t3-3780.token` | the T3 bearer for the T3 adapter (0600) |
| `~/.local/bin/comms` | the CLI on agents' PATH (runs `main`) |

`connector.json`:

```json
{
  "machine": "lim-builder",
  "secretFile": "~/.config/agent-comms/lim-builder.secret",
  "convexUrl": "http://127.0.0.1:3240",
  "adapters": ["t3"],
  "t3": { "baseUrl": "http://127.0.0.1:3780", "authFile": "~/.config/agent-comms/t3-3780.token" }
}
```

Install or update:

```sh
cp deploy/systemd/agent-comms-*.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now agent-comms-convex agent-comms-connector
# after merging to main: push functions, then restart the connector
scripts/local-convex-push.sh ~/.local/share/agent-comms/convex
systemctl --user restart agent-comms-connector
journalctl --user -u agent-comms-connector -f
```

The backend binary comes from the Convex CLI's download cache (`~/.cache/convex/binaries/<version>`, version recorded in the state dir's `config.json`). The unit pins Node by its fnm install path, not a shell's multishell path.
