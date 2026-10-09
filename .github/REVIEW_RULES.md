# AI review rules (shared by our AI reviewers)

This repository is a Convex-backed, cross-machine agent messaging and control plane. Extra scrutiny is required around:
- Message delivery guarantees, ordering, retries, and idempotency across processes and machines
- Authentication, authorization, and key/secret handling
- Concurrency and races (especially around Convex mutations/actions and scheduler use)
- Data integrity across module boundaries and persisted state transitions

Four bots review PRs here: Copilot, Bugbot, Codex and Macroscope. Each one has a lane. Stay in your lane and don't repeat a finding another bot has already posted.

| Bot | Lane | Volume cap |
|---|---|---|
| Copilot (Lite) | Fast first pass: obvious bugs, typos in logic, API misuse, repository conventions | ≤5 inline |
| Cursor Bugbot | Primary bug-finder: logic errors, edge cases, regressions, broken invariants, secrets or credentials in logs, concurrency and races | Bugbot default |
| Codex (GPT-6.1 Sol) | P0/P1 correctness only, plus missing tests for changed behavior | 1 comment, ≤5 items |
| Macroscope | Correctness and approvability checks (neutral check runs). Its agreement is required before merge (CR-36). | Macroscope default |

Auth and cross-module contracts have no dedicated bot lane; only Macroscope's correctness check covers them.

Rules for every reviewer:
- Report only issues you'd block a merge on or that will clearly cause a bug or incident. Skip style, naming, formatting, and anything linters/typecheckers catch (CI covers those).
- Before you comment, read the PR's existing review comments. If someone already flagged the issue, skip it, or reply in that thread only to add new evidence.
- **Start every finding with its severity tag:** `[P0]`, `[P1]` or `[P2]`. Never post nits. review-gate reads this tag (RG-5, advisory; not yet wired on this repo), and untagged findings count as non-blocking.
  - `[P0]` blocks merge: data loss or corruption, a security, auth or secret exposure, a broken wire contract, a crash on a main path, an irreversible side effect.
  - `[P1]` fix before merge, or the author records why not: a correctness bug in the changed behavior, a race, an idempotency or ordering bug, a behavior change with no test.
  - `[P2]` fix or file a follow-up: weak error handling, a perf risk, dead code, a test that mirrors the implementation.
- Each finding must include file:line, a concrete failure scenario (inputs → wrong outcome), and a suggested fix.
- Focus attention on behavior changes that affect message delivery, retries, idempotency, auth, and state transitions in Convex functions, and less on generated, vendored, or lock files.
- If you find nothing in your lane, say so briefly, or post nothing (Codex posts nothing when there are no findings).

Path scope and exclusions:
- Skip docs and generated/vendored artifacts: `**/*.md`, `docs/**`, `**/pnpm-lock.yaml`, `.repos/**`, `vendor/**`, `third_party/**`, `**/dist/**`, `**/_generated/**`, `**/node_modules/**`

Setup notes (for maintainers):
- Codex review runs via the ChatGPT Codex GitHub connector (`chatgpt-codex-connector[bot]`); no `OPENAI_API_KEY` is needed here.

