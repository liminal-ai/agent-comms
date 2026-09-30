# Shared acceptance check (local), 2026-09-30

lim-builder; local Convex (3240); connector `cedar-connector-m5` (main, default socket, T3 adapter); Hazel's T3 v0.0.44 on 3780. Homes: `t3-native` (native Claude, T3), `t3-lhc` (Claude-LHC, T3), `cc-a` (Claude Code terminal with Hazel's mod). "Typed directly" = a foreign `thread.turn.start` in T3 (what the web UI sends), or typing in the Claude Code terminal; every such text carries the marker `PRIVATE-ACC`.

| # | Check | Result |
|---|---|---|
| 1 | The three homes are promoted and show online in the web view | Pass: cc-a, t3-lhc, t3-native green (`1-directory.png`); T3 presence is polled from the thread session. |
| 2a | t3-native → t3-lhc with `comms send` from its own shell | Pass: `replied`, "Canberra", linked. |
| 2b | cc-a → t3-native | (Hazel) |
| 2c | t3-lhc → cc-a | pending |
| 3 | Lee's group in the web view, post addressing two; only those woken, both replies linked | pending |
| 4 | Lee types into a running comms turn | T3 (t3-native): the typed message entered the turn → `ambiguous`; notice sent; the agent's own `comms reply` completed it (`replied`, "ACC-4"). Claude Code: (Hazel) |
| 5 | An answer that needs the agent's own work | T3 (t3-lhc, shell command): collected normally, `replied`, "6" (correct). Claude Code: (Hazel) |
| 6 | Nothing typed directly appears in Convex | pending (grep for PRIVATE-ACC at the end) |
| 7 | An answer wakes the requester, nothing it does next is collected | pending |
| 8 | Connector killed mid-delivery and restarted | pending (joint) |
