# Capabilities pass: live acceptance

**All items 2-12 pass.** On the installed services (local Convex, the `agent-comms-connector` unit from `main`, the `comms` CLI on PATH), 2026-10-01. Items 2, 6 and 9-on-term-a are Hazel's (`hazel/`); the rest are Cedar's, scripted against the connector's socket with scripted Claude Code sessions (what the mod does: register, poll, report, answer restart checks truthfully) for `@smoke-a`, `@smoke-b`, `@cc-a`, `@cc-b`, `@mod-a`, `@mod-b`, `@fp1-term-lccbe`, the T3 agent `@t3-native` on 3780, and the real `comms` CLI. `lib.mjs` holds the helpers; each script writes a journal with a PASS or FAIL line per check.

| Item | Script / journal | Result |
|---|---|---|
| 2 | `hazel/item2-term-a-to-t3/` (term-a → @t3-native); `item2-t3-to-term-a.journal.txt` (@t3-codex, a Codex T3 agent, ran `comms send @term-a` in its own turn) | PASS both ways: term-a got "42" from t3-native (Hazel); t3-codex got "term-a pong" from term-a in the call, exit 0, result `acknowledged` (so no fallback, no extra turn) |
| 3 | `a-waits` | PASS: exit 4 at the bound with the id; the late answer arrives as a normal answer; `comms status` shows it (result `expired`) |
| 4 | `a-waits` | PASS: B's send to a waiting A doesn't wait and says so; both complete. Two simultaneous sends: exactly one waits. The cycle A→B→C→A closes in about 1 s, with no bound waited out |
| 5 | `a-waits` | PASS: a group wait returns both agents' answers; Lee is listed "in their inbox" and has it unread |
| 6 | `hazel/item6-send-owner/` | PASS (Hazel): returns at once; unread in the installed web view until opened |
| 7 | `b-restarts` | PASS: the connector killed after the answer is stored, then `comms await` gets it; the real CLI rides through a connector kill; the CLI killed mid-wait, then the answer goes to the thread after `WAIT_HELD_MS`; the CLI dies before acking, then one fallback after the window, and it stays readable in `comms status` |
| 8 | `c-races-run1` (8a, and a first 8b), `c-races` (8b widened) | PASS: replies fired at the bound −400…+400 ms: before the bound they come back in the call, at or after it they land in the thread; none lost. Acks fired across the waits sweep (its phase measured at :10.65): both outcomes occur (acknowledged before, fell-back from +250 ms), never two fallbacks |
| 9 | `d-reminders`; `hazel/` and `../mod-0.1.3/` (term-a) | PASS: a fire to @t3-native from @reminders labelled `setBy: lee, every 2m`, answered, and reported to @lee. A slow answer: skips, no pile-up. An ambiguous fire blocks one interval. On term-a with mod 0.1.3 (Hazel): the fire rendered "From: @reminders (system)" with the Reminder line and the done/blocked commands, answered and recorded; the report to term-a arrived as a notice, delivered and never collected |
| 10 | `d-reminders` | PASS: `--idle-for` and `--watch` defer, then fire. `--max 3`. Done and blocked stop it. A short expiry ends it and tells the creator (a notice). Pause and cancel during a running fire: no later fires, and the answer is recorded |
| 11 | `e-alerts-run1`, `-run2` (script timeouts, then the bug below), `e-alerts` | PASS: an injected uncertain delivery gives one alert to @lee and resolves on `comms reply`. A stopped connector gives one alert; stop, start, stop gives two. `connectorSilentMs` was 600000, lowered to 120000 for the test and restored to 600000 (logged in `e-alerts.journal.txt`) |
| 12 | `e-alerts` | PASS: none of 499 deliveries in 72 conversations went to a system participant |

## Bugs found and fixed during acceptance

Each fix was test-first (`fix-*-before` / `-after` journals), with a full check, on `main` and the installed connector restarted:

- **02a8343, 7a':** the CLI crashed with `socket hang up` when the connector dropped mid-`await`; it's now `ConnectionLost`, and the wait goes on.
- **77474ff, 7:** a turn reported by a session that was then superseded or ended was assumed still running from the cached report, never asked, so the participant's queue stayed blocked until a connector restart. Now only the reporting session can say "running"; otherwise the current session is asked.
- **8fb9b85, 11a:** the same class, in the outcome wait: if the new session registered before the connector began waiting for the turn's outcome, it waited on the new session, which never ran the turn. Now that's `lost`, and recovery asks.

## Side effects

- Draining sessions left by aborted runs answered some old test deliveries "(stale: left over from an aborted acceptance run)". Answers to two old requests from @lee went to his inbox.
- One aborted run left a delivery `uncertain` (a stale session answered a check "no"), and R4 alerted @lee about it, which is correct.
- In 7a and 7a' the answer also fell back once: the connector restart resets Claude Code presence, so the ack couldn't prove it was the same turn. That's the duplicate the brief allows.
