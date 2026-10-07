# Released comms environments

Source: `liminal-ai/agent-comms`, cloned under `~/lim/code/agent-comms`; edits in `~/lim/wt/agent-comms/<task>`. Code pull requests run `pnpm check` and a packaging smoke check; allowlisted docs-only changes use [lightweight documentation validation](ci.md). A `v<version>` tag builds and publishes `agent-comms-<version>.tar.gz` with SHA256SUMS. Node 24.18.0 is the runtime requirement. The JavaScript/web artifact is independent of host CPU. Linux and macOS use Unix sockets; **v0.1.2 and newer support native Windows ARM64/x64** through current-user named pipes, with native PowerShell 7 (validated version pinned in the platform runbook) and Node matching the Windows architecture. WSL is not required for that connector/CLI path. Standalone Windows Claude hooks remain disabled.

This page covers multi-host (Convex) mode. For one machine with no Convex deployment, run `service.mjs` in local mode: see [local-mode.md](local-mode.md). Releases also carry `service.mjs` (local or convex mode in one process) and the Claude Code plugin under `claude-plugin/`.

For a normal native Windows installation, follow the [platform runbook](https://github.com/liminal-ai/platform/blob/main/wiki/comms-windows-native-setup.md). It covers prerequisites, protected current-user credentials, the SID pipe, local T3 binding and the normal-user logon task. Normal Macs and Windows machines have one installation connected to production comms, with no environment choice; only lim-builder has separate production and staging. The [ARM64 VM](https://github.com/liminal-ai/platform/blob/main/machines/leemoore785f.md) and [NucBox x64](https://github.com/liminal-ai/platform/blob/main/machines/nucbox-m6ultra.md) have live source-build messaging evidence. Neither record establishes a fresh v0.1.2 archive installation; NucBox reboot/login acceptance remains outstanding. The Unix examples below remain applicable to Linux/macOS; do not apply their permission modes or symlink layout literally to Windows.

## What is deployed

```text
~/lim/service/comms/<env>/
  releases/<version>/     released bundles and web assets
  current -> releases/<version>
  runtime/node           pinned Node executable
  config/                connector.json, web.json, secret/token files
  data/                  local runtime state; backend data only if self-hosted
```

Production and staging have distinct backend deployments, connector credentials, T3 credentials, sockets, and web ports. Never copy production's database or machine credential into staging. Promote the same built artifact; change environment config, not the built files.

The shared backend is Convex cloud, with separate production and staging deployments. The deployed team/project is `lee-moore:agent-comms`; see the [platform machine record](https://github.com/liminal-ai/platform/blob/main/machines/lim-builder.md) for URLs and runtime locations. A remote machine runs its connector against the corresponding shared deployment, not an independent database per laptop. Self-hosted Convex remains usable for local work and transition. Configured deployment URLs identify the actual backend; cloud migration is a separate data cutover, not just a renamed local deployment.

## Build and start

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm build:release 0.1.0
```

The resulting directory contains `connector.mjs`, `comms.mjs`, `setup.mjs`, `upgrade.mjs`, `serve-web.mjs`, `run-convex.mjs`, `web/`, and `release.json`. Windows-capable releases also include the `.cs` and `.ps1` companions beside the `.mjs` entrypoints; preserve them when installing or copying an artifact. It needs no node_modules or source checkout at runtime. Backend functions are deployed from the matching source revision with the Convex CLI; they reside in the selected Convex deployment.

Connector example (replace every example value with the selected environment's actual values):

```json
{
  "machine": "lim-builder-staging",
  "secretFile": "/absolute/path/config/machine.secret",
  "convexUrl": "https://STAGING.convex.cloud",
  "socket": "/absolute/path/private-socket-dir/connector.sock",
  "adapters": ["t3"],
  "t3": {
    "baseUrl": "http://127.0.0.1:13976",
    "authFile": "/absolute/path/config/t3.token",
    "protocol": 2,
    "environmentId": "EXPECTED-T3-ENVIRONMENT-ID"
  }
}
```

Get `environmentId` from the intended T3's `/.well-known/t3/environment`, cross-check it against that server's deployment record, and issue the bearer token from that same T3 home. At startup the connector checks identity before sending its credential, then requires a valid authenticated session. A mismatch fails startup. Existing legacy configurations without `environmentId` remain compatible; new installations must set it.

On Unix, the socket's parent is owner-only (0700) and secret files are 0600. Native Windows instead requires current-user ownership and private DACLs, a current-user SID pipe and the configured PowerShell helper path; use the Windows runbook rather than translating `chmod`. Give each machine+environment a unique machine ID when registering its secret in Convex. An agent home in comms uses that ID and a thread ID from that exact T3 server. Use an explicit `AGENT_COMMS_SOCKET` in the environment's CLI wrapper; do not let staging silently use the production default.

Web example:

```json
{
  "environment": "staging",
  "port": 3792,
  "convexUrl": "https://STAGING.convex.cloud"
}
```

The web service reads this file at startup and serves `/runtime-config.json`; the same static build can run in either environment. The URL must be reachable from the user's browser, including phones. A loopback URL only works on the server itself. No production fallback URL is baked into the build. The page title identifies the environment.

Without `adminTokenFile` in `web.json`, the web service serves the page statically and users enter the comms admin token in the UI. With `adminTokenFile`, the service runs in **proxy mode**: the page gets no token; it calls `/api/call` and `/api/watch` on the service, which adds the token (read from the file at each call, so it rotates without a restart) and forwards to Convex. Only the functions the page uses are reachable. Two more keys decide who is served; proxy mode refuses to start without both:

- `allowedClients`: the tailnet addresses (v4 and v6) of the devices allowed to use the page, matched against the single `X-Forwarded-For` value `tailscale serve` sets. Anything else, and any request without that header, gets 403. This is device-level: anyone on a listed device has the page's full admin power.
- `publicHosts`: the `host:port` names the page is published under; any other Host gets 403.
- `devAllowLoopback: true` adds one exception for development, header-less requests from loopback; the two keys above are still required. Never set it in a deployment.
- `socket`: listen on this unix socket (created mode 600) instead of `127.0.0.1:port`, and point `tailscale serve` at `unix:<path>`. Only the service's user and root (tailscaled) can open it, so no other local account can forge the forwarded client address. Use it in deployments.

```json
{ "environment": "prod", "port": 3790, "convexUrl": "https://<deployment>.convex.cloud",
  "adminTokenFile": "/path/to/admin-token",
  "allowedClients": ["100.x.y.z", "fd7a:115c:a1e0::..."],
  "publicHosts": ["<host>.ts.net:8461"],
  "socket": "/run/user/<uid>/agent-comms/web-prod.sock" }
```

The listener binds a unix socket (or 127.0.0.1 only); publish it with `tailscale serve --https=<port> unix:<path>`. Errors reach the page scrubbed (our own `{code, message}`, or a bare kind), never the call's arguments.

```sh
node current/connector.mjs --config config/connector.json
node current/serve-web.mjs config/web.json
AGENT_COMMS_SOCKET=/absolute/socket/path node current/comms.mjs status
```

Production processes belong in a service manager, with fixed absolute paths and restart-on-failure. Linux uses systemd user units; Mac uses launchd. The documented native Windows setup uses an Interactive/Limited per-user Scheduled Task and explicit versioned paths, without requiring symlinks or elevation. Do not use `vite`, `vite preview`, or source TypeScript to serve the deployed web/connector.

## Promote and roll back

1. Download the tagged release and verify its checksum. Record release.json's version and source commit.
2. Install under staging's `releases/<version>`, select it with `current`, and start staging services. Deploy backend functions to the explicit staging deployment if changed, then run `upgrade.mjs` with that deployment's admin token file.
3. Verify the configured T3 identity/auth, connector status and heartbeat, the served runtime URL, and a message/answer through a staging T3 thread. Confirm a wrong T3 identity is refused. Clean up test threads; do not substitute production for a staging check.
4. Back up production config and persistent state. Install the identical artifact in production, stop only its connector/web, repoint `current`, and restart. Apply any backend schema migration as a separately checked step with a recoverable backup.
5. Verify HTTP, runtime config, connector status and existing directory access. Preserve production participants, history, credentials, URLs, and outstanding work.

For a runtime regression, stop the affected service, restore its previous `current` target and configuration, then restart. A backend schema/data migration may require its own compatible restore; an older frontend bundle alone does not undo it.

## Convex cloud cutover

Use the selected team/project and explicit deployment selections. Set the application `COMMS_ADMIN_TOKEN` separately from the Convex deployment key. A connector gets a machine secret, never a Convex deployment/admin key. Deploy the source matching the release, then run `setup.mjs` for a fresh environment or `upgrade.mjs` for an existing one.

Qualify cloud staging first. For production, prevent new writes and stop delivery processing during the final export/import. Account for backend cron jobs too; stopping the connector alone does not freeze reminders. Use Convex's supported export/import with IDs and storage preserved, verify table counts and relationships, and update connector/web URLs only after the imported state is checked. Keep the old backend stopped as a rollback copy, never running a second scheduler over the same logical workload. Do not import production history into staging.

References: [Convex export](https://docs.convex.dev/database/import-export/export), [Convex import](https://docs.convex.dev/database/import-export/import).
