# M3 live validation: T3 adapter on T3 v0.0.44 (port 3780)

2026-09-30, lim-builder. Hazel's fresh T3 (`t3code-3780.service`, claude-lhc provider), her fixture threads (native Claude `thr-2b92…`, Claude-LHC `thr-36b7…`, Codex `thr-abad…`), the real connector with the T3 adapter against the local Convex deployment (3240). Requests sent with the `comms` CLI as `smoke-a`; "someone else" simulated by dispatching `thread.turn.start` / `thread.turn.interrupt` directly to T3 with a foreign message id (what the web UI does). Scripts here; they read the T3 bearer and admin token from files and print neither.

| Scenario | Provider | Result |
|---|---|---|
| Request answered and matched | native Claude | `replied`, answer `PONG-1` linked (`inReplyTo`, `collectedFrom`) |
| Request answered and matched | Claude-LHC | `replied`, `PONG-t3-lhc` |
| Request answered and matched | Codex | `replied`, `PONG-t3-codex` |
| Thread busy with someone else's 20 s turn | native Claude | ours waited, then ran as its own turn: `replied`, `AFTER-BUSY` |
| Someone types into our running turn | native Claude | `ambiguous` ("other input entered the turn: t3-user-message"); no text of theirs recorded |
| Our turn interrupted | native Claude | `failed` ("aborted: the turn ended without an answer (interrupted)"); nothing collected |
| Claude backgrounds a long command and ends the turn early | native Claude | the turn's own answer collected (`replied`); the real result is the agent's `comms reply` follow-up (Hazel's notes §7) |
| Connector SIGKILLed after `delivered`, restarted | Codex | recovered through the check after the lease (30 s): `replied` once, full answer; our message in the thread exactly once (twice: a first attempt's delivery recovered the same way) |

Measured: a turn our message starts has `latestTurn.requestedAt` equal to our message's `createdAt` to the millisecond (`t3-peek.mjs`), which the adapter now uses to refuse a later turn (e.g. a background-task wake) as ours.

`delivery-states.txt`: every delivery from these runs. The answers to `smoke-a` stay `pending`: it has no Claude Code session, and the connector claims nothing it can't hand over.

Known limit (Hazel's notes §6): Codex keeps the partial text as the answer of an interrupted turn, indistinguishable from a real answer; a Claude interrupt is detected (`assistantMessageId: null`).
