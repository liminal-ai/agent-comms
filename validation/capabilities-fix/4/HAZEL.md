# Fix pass 4: Hazel's live checks

All on the installed services: the connector, the local Convex at 3240, T3 at 3780 and term-a.
Cedar's items are in `README.md` / his folders here.

| Check | Folder | Result |
|---|---|---|
| term-a (mod 0.1.4), foreground `comms send` | `termA-foreground/` | answer printed between the proof markers; the mod sent `answer-seen` in turn 19a24b54, the wait's `waiterTurnId`; the result went to `acknowledged` 38 ms after `printedAt`; still acknowledged after the window, with no fallback and nothing more in term-a's mod log |
| term-a, `run_in_background` send | `termA-background/` | the CLI printed to its output file, which term-a didn't read, so no `answer-seen`; the result stayed `answered`, then `fell-back` once at about the wait's end + 2 min: one delivery (17:08:11), rendered "may already have been returned to your waiting comms send" |
| Wrenn's T3 send-and-wait (regression) | `wrenn-ack/` | before the fix this was wrongly acknowledged; now the wait has no `waiterTurnId`, the answer ACK-PONG came back in the call, and the result fell back once, with exactly one fallback message in fp1-native's thread |
| A live T3 turn changing under a waiting command | `t3-turn-change/` | fp1-native ran `comms send --wait 5m` to a ~150 s answer; Claude backgrounded it at 120 s and turn b703e9e3 completed with the wait open; the answer arrived and a new turn ran; the result fell back exactly once (17:16:12), one copy in the thread. The connector restarted during the run (Cedar's merge, 17:14:25); the fallback still landed once |
| term-a (mod 0.1.5), a real reminder fire with `--report-to @lee` | `termA-render/` | the fire read "Reminder: fix-pass render check (id …), set by @lee, every 1m. Fire 1. Your answer is reported to @lee."; answered PONG and recorded `replied`; the reminder ended `done` |

Name escaping is covered by `packages/protocol/test/fix-pass-render.test.ts`. Names with newlines
are now refused at creation (Cedar, section 2), so a forged name can't be fired live.

Open: the web inbox past one page, mark all read, and opening any conversation (needs a scratch
deployment: `../web/inbox-scratch.mjs`).
