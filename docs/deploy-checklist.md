# Deploying and recovering agent-comms

A checklist for the installed services on a host (lim-builder today): the local Convex backend (`agent-comms-convex.service`), the connector (`agent-comms-connector.service`, run from `main` in `/srv/work/agent-comms`), and the `comms` wrapper on PATH. Secrets live in `~/.config/agent-comms/` and are only ever passed by file; never print them.

## Deploying a change

1. **Check.** On `main`: `scripts/capped.sh --mem 4G timeout -s KILL 640 pnpm check` exits 0.
2. **Push Convex.** `scripts/local-convex-push.sh ~/.local/share/agent-comms/convex` (with `CONVEX_TMPDIR` set to a scratch directory). Read its output: added or deleted indexes are expected; a schema validation error means an existing row doesn't fit the new schema. Stop and migrate first (see below); never edit rows by hand to make a push pass.
3. **Upgrade.** `node scripts/upgrade.ts --url http://127.0.0.1:3240 --admin-token-file ~/.config/agent-comms/admin-token`. Idempotent; run it after **every** push. It creates the system participants (`@reminders`, `@alerts`), repairs one that was retired or paused, and gives any agent without an owner the default owner (`@lee`). The JSON it prints says what it changed.
4. **Restart the connector.** `systemctl --user restart agent-comms-connector.service`, then `comms status` answers. A restart is safe at any time: deliveries in flight are recovered by asking the harness (`check`), never re-run blind; mod sessions re-register by themselves; a waiting `comms send` keeps waiting through it.
5. **Regenerated code.** If the push changed `convex/_generated/`, commit it.

## Upgrading an older deployment

Deployments from before the capabilities pass need, in order (each step is one deploy as above):

1. **Owner, step 1** (capabilities R0): the schema gains `ownerId` beside the old `owner` string. Push.
2. **Owner, step 2** (R1): push, then run `scripts/upgrade.ts`. It sets `ownerId` for every agent: the person its old `owner` string named, else the default owner. Promotion now requires an owner.
3. **Owner, step 3** (R1): the schema drops the `owner` string. This push fails while any row still has it, so run step 2's upgrade first. On lim-builder this was done 2026-10-01 (20 agents, no old strings).
4. **Capabilities and the fix pass:** push, `upgrade.ts`, restart. New indexes build on the push; nothing needs backfilling. Waits created before the fix pass have no `waiterTurnId` and fall back once (safe).

Skipping straight to the current code on an old deployment fails at step 3's schema check; go through the stages in order.

## Recovering

| Symptom | What to do |
|---|---|
| `comms` says no connector | `systemctl --user status agent-comms-connector`; restart it. A waiting CLI retries on its own; a send that dropped prints `--key`: rerun with it, which can't post twice. |
| A delivery is `uncertain` (an alert in the owner's inbox) | It can't be told whether it ran, and it's never re-run. Ask the agent; the agent completes it with `comms reply <message-id>`, which resolves the alert. |
| A connector-silent alert | The host's connector isn't heartbeating: restart it. The alert resolves on the next scan once it's heard from. |
| A reminder blocked with "the fire failed: …" | One reminder's fire threw; the rest carry on. Fix the cause (e.g. text over the limit), then `comms reminder resume <id>` or cancel it. |
| A participant stuck with nothing delivered | `comms status <message-id>` for the request. If its delivery is `delivered` with no session, the connector asks the next session that registers; a connector restart does the same. |
| A system participant was retired by hand | `scripts/upgrade.ts` puts it back. |
| Convex push refused by schema validation | A row predates the change. Write a migration (as the owner steps did) and run it before the push; don't loosen the schema. |

## Testing against real harnesses

Standing rule (V2 port incident, 2026-10-03): synthetic test agents in real harness threads never run full-access. Their threads are approval-required, and a test harness approves only a command that matches exactly what the test asked for; it declines everything else. Long-running turns use text-only prompts, not shell commands. A full-access test agent acts on its own when something looks broken (one restarted a scratch systemd unit and read scratch configs). Test connectors run as separate units with their own config, socket and Convex deployment, never the live ones.

## After any of these

`comms status`, `comms agents --as <an agent here>`, and the web view's Hosts and Alerts pages should show the host heard from and no open alerts you didn't expect.
