# Copilot code review instructions

Your lane: a fast first pass. See `.github/REVIEW_RULES.md`. Three other bots (Bugbot, Claude, Codex) run deeper reviews.

- Flag only clear bugs, incorrect API usage, broken invariants, and violations of repository rules in `.github/REVIEW_RULES.md`. At most 5 inline comments.
- Prioritize risks in this codebase: message delivery and ordering, retries and idempotency, Convex mutations/actions and scheduler usage, auth/permissions, and data integrity at module boundaries.
- Do not comment on style, naming, formatting, or anything a linter/typechecker catches.
- Do not restate the PR description and do not post praise.
- Skip vendored/generated paths: `.repos/**`, `vendor/**`, `third_party/**`, `**/dist/**`, `**/_generated/**`, `**/node_modules/**`, and lockfiles.
- Prefer GitHub suggested-change blocks for one-line fixes.
- (The merge gate treats Copilot findings as untagged and non-blocking. The author still replies to each one.)

