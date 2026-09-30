# Shared acceptance check (local), 2026-09-30

lim-builder; local Convex (3240); connector `cedar-connector-m5` (main, default socket, T3 adapter); Hazel's T3 v0.0.44 on 3780. Homes: `t3-native` (native Claude, T3), `t3-lhc` (Claude-LHC, T3), `cc-a` (Claude Code terminal with Hazel's mod). "Typed directly" = a foreign `thread.turn.start` in T3 (what the web UI sends), or typing in the Claude Code terminal; every such text carries the marker `PRIVATE-ACC`.

| # | Check | Result |
|---|---|---|
| 1 | The three homes are promoted and show online in the web view | Pass: cc-a, t3-lhc, t3-native green (`1-directory.png`); T3 presence is polled from the thread session. |
| 2a | t3-native → t3-lhc with `comms send` from its own shell | Pass: `replied`, "Canberra", linked. |
| 2b | cc-a → t3-native | Pass: cc-a (prompted by Hazel) sent "what is 11 times 11?"; `replied`, "121", linked; the answer woke cc-a and was delivered, not collected. |
| 2c | t3-lhc → cc-a | Pass: sent from t3-lhc's shell; cc-a woken by the mod; `replied`, "144", linked. |
| 3 | Lee's group in the web view, post addressing two; only those woken, both replies linked | Pass: group created and posted in the web view (headless Chrome) with lee, t3-native, t3-lhc, cc-a; post addressed t3-lhc and cc-a; exactly those two woken, both `replied` and linked; t3-native not woken (`3-group.png`). |
| 4 | Lee types into a running comms turn | T3 (t3-native): the typed message entered the turn → `ambiguous`; notice sent; the agent's own `comms reply` completed it (`replied`, "ACC-4"). Claude Code (cc-a, Hazel): typed text entered our turn → `ambiguous` (entered: composer); the mod showed the unmatched notice; cc-a's `comms reply` ("The command printed 17.") completed it. |
| 5 | An answer that needs the agent's own work | T3 (t3-lhc, shell command): collected normally, `replied`, "6" (correct). Claude Code (cc-a, Hazel): one turn with a background shell, a helper subagent and a foreground shell; both task notifications arrived in our turn, linked by their `toolUseId`; the answer was collected normally ("…5…81…6"); the helper's own answer was not reported. |
| 6 | Nothing typed directly appears in Convex | Pass: none of the 105 messages in Convex contains `PRIVATE-` (T3-side and Claude Code-side markers) (`acc-67.mjs`). |
| 7 | An answer wakes the requester, nothing it does next is collected | Pass: 45 collected answers, none from an answer's delivery; no answer delivery ever went past `delivered`; 2b's answer woke cc-a and was delivered only. |
| 8 | Connector killed mid-delivery and restarted | T3 (t3-codex): SIGKILL (Hazel) 31 s after `delivered`, recreated 2 s later; `replied` once, full answer, our message in the thread once. Claude Code: (Hazel) |

## Incident (Hazel, during 2b)

cc-a's first test folder sat under `/srv/agents/hazel`, so its Claude Code session loaded Hazel's CLAUDE.md and, when asked to message t3-native, tried `lhc-agent` (the relay) instead of `comms`. Nothing was sent (unknown relay target); Hazel killed the session before a suggested follow-up to a live seat could go out. cc-a was restarted in `/tmp/hazel-mod-work` with a PATH holding only `comms` and `node`, and 2b was rerun cleanly. Lesson for promoting terminal agents: an agent's working folder decides which instructions it loads, and a folder inheriting a seat's instructions can reach the relay and live seats. Keep test terminals out of seat homes.
