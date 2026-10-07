# AI review rules (shared by all four reviewers)

This repository is a Convex-backed, cross-machine agent messaging and control plane. Extra scrutiny is required around:
- Message delivery guarantees, ordering, retries, and idempotency across processes and machines
- Authentication, authorization, and key/secret handling
- Concurrency and races (especially around Convex mutations/actions and scheduler use)
- Data integrity across module boundaries and persisted state transitions

Four bots review PRs here. Each one has a lane. Stay in your lane and don't repeat a finding another bot has already posted.

| Bot | Lane | Volume cap |
|---|---|---|
| Copilot (Lite) | Fast first pass: obvious bugs, typos in logic, API misuse, repository conventions | ≤5 inline |
| Cursor Bugbot | Primary bug-finder: logic errors, edge cases, regressions, broken invariants | Bugbot default |
| Claude (Opus 5.5) | Security, secrets/PII in logs, auth, concurrency/races, data integrity, cross-module contracts | ≤5 inline + 1 summary |
| Codex (GPT-6.1 Sol) | P0/P1 correctness only, plus missing tests for changed behavior | 1 comment, ≤5 items |

Rules for every reviewer:
- Report only issues you'd block a merge on or that will clearly cause a bug or incident. Skip style, naming, formatting, and anything linters/typecheckers catch (CI covers those).
- Before you comment, read the PR's existing review comments. If someone already flagged the issue, skip it, or reply in that thread only to add new evidence.
- Each finding must include file:line, a concrete failure scenario (inputs → wrong outcome), and a suggested fix.
- Focus attention on behavior changes that affect message delivery, retries, idempotency, auth, and state transitions in Convex functions, and less on generated, vendored, or lock files.
- If you find nothing in your lane, say so briefly, or post nothing (Codex posts nothing when there are no findings).

Path scope and exclusions:
- Skip docs and generated/vendored artifacts: `**/*.md`, `docs/**`, `**/pnpm-lock.yaml`, `.repos/**`, `vendor/**`, `third_party/**`, `**/dist/**`, `**/_generated/**`, `**/node_modules/**`

