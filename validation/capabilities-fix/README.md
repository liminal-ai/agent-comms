# Capabilities fix pass: evidence

Brief: `docs/06-capabilities-fix-pass.md`; follow-up: `docs/07-fix-pass-followup.md`. Each fix has a failing test committed on its own before it; the `*-before` and `*-after` journals in each folder are their raw runs.

| Folder | What |
|---|---|
| `0/` | the section 0 contract's tests (proof markers, register's turn) |
| `1/` | section 1 (1.1-1.7) |
| `2/` | section 2, Convex and CLI |
| `4/` | section 4: Cedar's restarts with the kill proven, 7c with a real CLI kill, the scale run on a scratch deployment (`scale/`), and acceptance 3-12 rerun (`acceptance/`); Hazel's live checks (`HAZEL.md`) |
| `p3/` | Reed's minor findings: the agreed bugs |
| `followup/` | the follow-up items and their re-check |
| `mod-1.1/`, `render/`, `web/`, `claude-code-tool-output/`, `t3-tool-output/` | Hazel's |
| `repros/`, `followup/repros/` | the reviewers' reproductions, as given |

**Failure isolation (follow-up 9)** is proven two ways:
- **In convex-test** (`convex/reminders.test.ts`, "fix pass 1.4" and "fix pass 1.5"): a failure injected after a reminder fire's message is written, and after a report is written. Each reminder runs in its own Convex sub-transaction, so nothing is left behind, only that reminder is blocked, the tick carries on, and a failed report never rolls back the collected answer.
- **Live, on the installed services** (`followup/recheck/`): the same injected failures (`COMMS_TEST_FAULT`) against the real backend.

Pre-validation alone wouldn't prove it (Alder's point): these tests fail after writing has begun.
