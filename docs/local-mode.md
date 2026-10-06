# Run comms locally (SQLite mode)

Use this to run agent-comms on one machine with no Convex account, deployment or machine
enrollment. One process, `service.mjs`, holds the data in a SQLite file, runs the comms backend
and its timers, runs the connector that delivers to T3 threads and Claude Code terminals on this
machine, and serves the web view. Agents use the same `comms` CLI, identities, conversations,
replies, reminders, alerts and inbox as in multi-host mode.

You are done when the service is running, `comms status` lists your agents, a message to a T3
agent comes back answered, and the web view shows the conversation. Each step below says how
to check it.

**When to choose it.** Local mode suits one machine whose agents only talk to each other. It
can't reach agents on other machines; that needs the Convex multi-host mode
([releases.md](releases.md)). The two modes keep separate stores, and nothing is copied
between them. Switching mode means starting with an empty local store.

## What you need

- Node **24.18.0** (the `node:sqlite` built into Node 24 is the database; nothing else is
  installed). macOS (Apple silicon or Intel) or Linux. Windows: see [Known limits](#known-limits).
- A built release directory, `agent-comms-<version>/`. It runs without the source checkout.
- For T3 agents: the T3 server whose threads are the agents, its environment ID, and a
  connector token issued by that server.
- For Claude Code terminals: Claude Code with function hooks (macOS or Linux).

## 1. Build and install the release

Until local mode is in a published release, build it from the branch or commit you were given,
in a worktree of its own (the canonical checkout stays on main):

```sh
COMMS_REF=origin/feat/local-sqlite-mode     # the branch or commit you were given
COMMS_VERSION=0.2.0-local.1                 # a version name for this build; unique per build
git -C ~/lim/code/agent-comms fetch origin
git -C ~/lim/code/agent-comms worktree add --detach ~/lim/wt/agent-comms/local-build "$COMMS_REF"
cd ~/lim/wt/agent-comms/local-build
pnpm install --frozen-lockfile
pnpm build:release "$COMMS_VERSION"         # prints dist/agent-comms-$COMMS_VERSION
```

Install it as a versioned release with a `current` link. Keep config and data outside the
release so an upgrade only swaps the link:

```sh
umask 077
base="$HOME/lim/service/comms-local"
mkdir -p "$base/releases" "$base/config" "$base/data" "$base/run"
cp -R "dist/agent-comms-$COMMS_VERSION" "$base/releases/"
ln -sfn "releases/agent-comms-$COMMS_VERSION" "$base/current"
node "$base/current/service.mjs" --help
```

The release holds `service.mjs` (the service and its admin commands), `comms.mjs` (the CLI),
`web/` (the web view), `claude-plugin/` (the Claude Code plugin) and Windows helper files.
Keep them together.

## 2. Write the config

`$base/config/service.json`. Every path is absolute. `mode` is required:

```json
{
  "mode": "local",
  "environment": "local",
  "dataDir": "/Users/USER/lim/service/comms-local/data",
  "owner": "lee",
  "machine": "local",
  "socket": "/Users/USER/lim/service/comms-local/run/connector.sock",
  "web": { "port": 3290 }
}
```

| Field | Meaning |
|---|---|
| `dataDir` | Private store directory (must be owner-only, `chmod 700`). It holds `comms.sqlite` and two generated credentials. |
| `owner` | The person who owns agents and receives alerts. Created on first start. |
| `machine` | The name agents' homes refer to. Keep it stable: agents registered under one name aren't delivered to under another. |
| `web.port` | The web view and the admin API, on 127.0.0.1 only. The admin commands find the service by this port. |
| `socket` | This service's socket, which every client must use; see [step 4](#4-point-every-client-at-the-socket). |
| `adapters`, `t3` | Optional. Deliver to T3 threads; see [step 5](#5-bind-the-t3-server). |

A config with `convexUrl`, `secretFile` or `adminTokenFile` is refused: those belong to
multi-host mode. Giving a local config to `connector.mjs` is also refused.

## 3. Start the service

```sh
node "$base/current/service.mjs" --config "$base/config/service.json"
```

First start creates the store and its credentials. Expect:

```text
created local store <id> in .../data
created @lee (person, the default owner)
web view and admin API on 127.0.0.1:3290
machine local: listening on <socket>
local comms service running: machine local, socket <socket>
```

It runs until Ctrl-C or SIGTERM. To keep it running, see
[Restart and run it as a service](#restart-and-run-it-as-a-service).

**Refusals are safety checks, not errors to work around.** The service refuses to start, and
changes nothing, when:
- another service already has this store open (one writer per store);
- something is already listening on its socket (it never removes a live socket);
- the data directory or a credential isn't private, or a credential doesn't belong to this store;
- the store was made for another mode or format, or holds data this build's schema rejects.

Read the message, fix the cause, and start again. Never delete `comms.sqlite` or the credentials
to get past a refusal: that discards every conversation and pending delivery.

## 4. Point every client at the socket

The `comms` CLI, the Claude Code plugin and agents inside T3 find the service through its socket.
This guide uses an explicit private socket, `$base/run/connector.sock`, so local mode can't be
confused with a shared comms connector on the same machine. Every client then needs
`AGENT_COMMS_SOCKET` set to it: the CLI wrapper below, each Claude Code terminal (step 7) and
the T3 server's environment (step 5). A client without it reaches the default socket, which is
another service or nothing.

Install a CLI wrapper in `~/lim/bin` that always names the socket:

```sh
mkdir -p "$HOME/lim/bin"
cat > "$HOME/lim/bin/comms-local" <<WRAPPER
#!/bin/sh
AGENT_COMMS_SOCKET="$base/run/connector.sock" exec node "$base/current/comms.mjs" "\$@"
WRAPPER
chmod 700 "$HOME/lim/bin/comms-local"
"$HOME/lim/bin/comms-local" status
```

`status` answers `connector on local`; agents appear once registered. Agents call the CLI as
`comms`, so the `PATH` you give T3 and terminals should reach this wrapper under that name
(for example a directory holding a `comms` link to it) and no other `comms`.

**Simpler, on a machine with no other comms:** leave `socket` out of the config. The service then
uses the standard per-user socket (macOS `~/.agent-comms/connector.sock`; Linux
`$XDG_RUNTIME_DIR/agent-comms/connector.sock`) and clients need no `AGENT_COMMS_SOCKET`.

**Windows:** the socket is a named pipe that belongs to the current user,
`\\.\pipe\agent-comms-<user SID>-<suffix>` (the SID from PowerShell's
`[Security.Principal.WindowsIdentity]::GetCurrent().User.Value`; the suffix lowercase letters,
digits and dashes). The service refuses any other pipe. Leaving `socket` out uses the user's
default pipe.

## 5. Bind the T3 server

The service delivers to T3 threads through the T3 server's API. Bind it to exactly one server:

1. Read `http://127.0.0.1:<t3-port>/.well-known/t3/environment` and note `environmentId`.
2. Issue a connector token from that same server's data directory and exchange it for the
   scoped token (orchestration read/operate only), as in
   [comms-setup.md](https://github.com/liminal-ai/platform/blob/main/wiki/comms-setup.md#bind-to-the-correct-t3-server)
   in the platform repository:

   ```sh
   umask 077
   "$T3" auth pairing create --base-dir "$T3_DATA" --ttl 5m --label comms --json > "$base/config/t3-pairing.json"
   node "$PLATFORM/scripts/t3-connector-token.mjs" "http://127.0.0.1:$T3_PORT" "$base/config/t3-pairing.json" "$base/config/t3.token"
   rm "$base/config/t3-pairing.json"
   ```
3. Add to the config, then restart the service:

   ```json
   {
     "adapters": ["t3"],
     "t3": {
       "baseUrl": "http://127.0.0.1:5230",
       "authFile": "/Users/USER/lim/service/comms-local/config/t3.token",
       "protocol": 2,
       "environmentId": "the environmentId from step 1"
     }
   }
   ```

`environmentId` is required: at startup the service checks the server's identity before sending
the token, so it can't bind to the wrong T3. Startup logs
`T3 adapter: http://127.0.0.1:5230 (orchestration protocol 2)`.

Agents in T3 threads use `comms` from their shell, so start the T3 server with
`AGENT_COMMS_SOCKET="$base/run/connector.sock"` in its environment and the wrapper reachable as
`comms` on its `PATH`. A T3 server started without these needs a restart to pass them to new
sessions.

## 6. Register agents

With the service running, register each agent where it lives:

```sh
service="node $base/current/service.mjs"
$service register --config "$base/config/service.json" kit --harness t3 --locator "$THREAD_ID" --description "Comms manager"
$service register --config "$base/config/service.json" scout --harness claude-code --locator scout
"$HOME/lim/bin/comms-local" status
```

- T3 agents: `--locator` is the thread ID.
- Claude Code terminals: `--locator` is the agent's own name, the same value as its
  `AGENT_COMMS_PARTICIPANT`.
- The owner defaults to the config's `owner`; `--owner` names another person (who must exist).
- To move an existing agent to another thread or terminal, use the same command with `--rebind`.
- Add more people with the web view, or `service.mjs seed --config ... seed.json` (the format
  of `scripts/dev-setup.ts`; `home.machine` may be left out).

Check: send a message to a T3 agent and wait for its answer.

```sh
"$HOME/lim/bin/comms-local" send --as scout @kit "Reply with the word READY." --wait 3m
```

`@kit answered` followed by the answer means delivery, the turn and collection all work.

## 7. Set up a Claude Code terminal

The plugin is in the release at `claude-plugin/`. It needs three things in the terminal's
environment: `AGENT_COMMS_PARTICIPANT` (the registered name), function hooks turned on, and
`AGENT_COMMS_SOCKET` (this service's socket).

Give each terminal agent its own Claude Code home so its settings and plugin don't touch your
own `~/.claude`:

```sh
name=scout
home_dir="$HOME/.config/agent-comms/claude/$name"
mkdir -p -m 700 "$home_dir"
printf '{ "env": { "CLAUDE_CODE_ENABLE_FUNCTION_HOOKS": "1" } }\n' > "$home_dir/settings.json"
CLAUDE_CONFIG_DIR="$home_dir" claude plugin marketplace add "$base/current/claude-plugin"
CLAUDE_CONFIG_DIR="$home_dir" claude plugin install agent-comms@agent-comms-local
```

Start it in a folder of its own, outside any agent's home (Claude Code reads the `CLAUDE.md` of
the folder it starts in and its parents), with `comms` on `PATH`:

```sh
mkdir -p "$HOME/comms-terminals/$name" && cd "$HOME/comms-terminals/$name"
export AGENT_COMMS_SOCKET="$base/run/connector.sock"
CLAUDE_CONFIG_DIR="$home_dir" AGENT_COMMS_PARTICIPANT="$name" claude
```

For a one-off session without installing, `claude --plugin-dir "$base/current/claude-plugin"`
loads the same plugin. The install is a copy: after upgrading the release, run
`claude plugin marketplace update agent-comms-local` and
`claude plugin update agent-comms@agent-comms-local` with the same `CLAUDE_CONFIG_DIR`, then
restart the terminal.

Choose the terminal's permission mode for the work it does. A long-running agent that answers
other agents isn't required to ask before each action.

Check: the web view shows the agent idle or busy rather than **mod not connected**, and a
message to it is answered. If not, follow "When the mod isn't connected" in
`packages/claude-code-mod/README.md`.

## 8. Open the web view

```sh
node "$base/current/service.mjs" web-url --config "$base/config/service.json"
```

This prints `http://127.0.0.1:3290/#token=...`. Open it in a browser on this machine. The page
moves the token into that tab's session storage and removes it from the address bar. The link
contains the admin token, so don't paste it into chats or logs. A new tab or browser session
needs the link again (or paste the token from `dataDir/admin.token` into the page's prompt).

The web view and admin API answer only on 127.0.0.1, only to pages served from that address,
and only with the token.

## Restart and run it as a service

Stop the service with Ctrl-C or SIGTERM; start it with the same command. Everything is in the
store: conversations, pending and in-flight deliveries, waits, reminders, alerts. On start it
runs the timers once, so reminders and fallbacks that came due while it was stopped happen then.
A delivery that was in a turn when the service stopped is recovered after its lease (about a
minute) and its answer collected once.

To keep it running, use the platform's service manager with absolute paths and restart on
failure. Run one instance per store.

- **macOS:** a user LaunchAgent whose `ProgramArguments` are the `node` path, the `service.mjs`
  path, `--config` and the config path, with `KeepAlive` true, loaded with
  `launchctl bootstrap gui/$(id -u) <plist>`.
- **Linux:** a systemd user unit with
  `ExecStart=<node> <base>/current/service.mjs --config <base>/config/service.json` and
  `Restart=on-failure`.

**Upgrade:** stop the service, install the new release and move `current`, start it. The store
is checked against the new build's schema at startup; if stored data doesn't fit, it refuses and
the previous release still opens it. **Back up** by copying `dataDir` while the service is
stopped.

## Run a disposable test fixture

Test local mode without touching anything shared. Give the fixture all of its own state:

- its own T3 server, `t3 serve --host 127.0.0.1 --port PORT --base-dir FIXTURE/t3`, started
  with `AGENT_COMMS_SOCKET` set to the fixture's socket, and its own token issued as in step 5;
- its own `dataDir`, `socket` (always explicit for fixtures), `web.port` and `machine` name;
- a CLI wrapper naming the fixture socket.

Never point a fixture at a shared T3 server, shared comms socket or Convex deployment. To remove
a fixture, stop its service and T3 server and delete the fixture directory.

## Known limits

- **Not a general Convex runtime.** Local mode runs this repository's Convex functions with the
  pinned `convex` 1.46.0, through the same registered-function internals `convex-test` uses.
  Features the functions don't use (scheduler, actions, file storage, auth, search) fail
  closed. Upgrading `convex` needs the dual-backend test suites to pass again.
- **One machine.** No messages to or from other machines; no transfer between local and
  multi-host stores.
- **Semantics differ from Convex at the edges.** Functions run one at a time (stricter than
  Convex's concurrency); Convex's per-transaction read/write limits aren't enforced.
- **Claude Code terminals:** macOS and Linux only. The plugin's function hooks are disabled on
  Windows.
- **Windows:** untested. The pull request's Windows x64 CI runs the service tests and the
  packaged smoke (pipe transport, private data directory, credentials); until those pass, and
  until it's used on a Windows machine, don't rely on local mode there. The data directory must
  be new, empty or already private to the user; the service makes a new or empty one private.
- **`node:sqlite`** is still marked as under development in Node 24; the release is tested with
  24.18.0.
