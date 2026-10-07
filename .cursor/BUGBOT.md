# Bugbot rules

You are the primary bug-finder for this repo (see `.github/REVIEW_RULES.md` for the other bots' lanes).

Focus:
- Logic errors, off-by-one and boundary bugs, null/undefined paths, unhandled promise rejections, missing awaits.
- Regressions: changed behavior that existing callers or tests rely on.
- Error handling that swallows failures or leaves state half-written (write then persist then rollback).
- Message delivery, ordering, retries and idempotency across processes/machines.
- Concurrency/races around Convex mutations/actions and scheduler usage.
- Secrets, tokens, or URLs that contain credentials reaching logs or error messages.

Ignore:
- Style, naming, formatting, import order, lint-level issues (CI handles these).
- Vendored/generated paths: `.repos/**`, `third-party/**`, `vendor/**`, `**/dist/**`, `**/*.gen.ts`, `**/_generated/**`, lockfiles.

Format: one comment per distinct bug; include a concrete failing scenario. No praise, no summaries of what the PR does.

