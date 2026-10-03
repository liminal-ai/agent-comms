# docs/09 V2 adapter fixes: evidence for Alder's re-check

Branch `cedar`, not on main and not deployed live (3780 waits for the re-check). Each fix has its failing test committed first.

| Item | Failing test | Fix | Output |
|---|---|---|---|
| P1 claim re-checked before every dispatch (V2) | b7ced97 | 9d324bc | `p1-failing.txt`, `p1-passing.txt` |
| P2 outage clock resets only on sync (V2) | 9813c9e | be6f280 | `p2-failing.txt`, `p2-passing.txt` |
| P2 ported to the v0.0.44 adapter | c768c59 | 9bf313c | `p2-v044-failing.txt`, `p2-v044-passing.txt` |
| 3 courtesy idle wait capped (90 s) | 738ea57 | 323c1c9 | `3-failing.txt`, `3-passing.txt` |
| 4 explicit `comms reply` settles the request (Convex, all harnesses) | a9f340a | fac9ca9 | `4-failing.txt`, `4-passing.txt`; live on stock 13976 + scratch 3214: 8b41672, `raw/results.jsonl` (`replyDuring`), `4-live-connector.journal.txt` |
| 5 the `waiting` settle documented | (docs) | 55acb5c | `docs/t3-v2-notes.md` |

Full check on the branch tip: `full-check.txt` (exit 0).

Notes:
- The v0.0.44 adapter dispatches once, right after its gate, with no retry: P1 has no counterpart there.
- Tests changed to the agreed behaviour: two in `convex/comms.test.ts` (a reply during the turn was a follow-up; now it's the answer), and the v0.0.44 3.2 snapshot test's wait (100 ms to 500 ms, because the first resubscription is now backed off).
- Item 4 also adds one sentence to the delivery text (kept by Reed): "If you answer with `comms reply` during this turn, that is your answer and your final message isn't sent."
- Live 3780: merge, Convex push, upgrade and connector restart go together after the re-check.
