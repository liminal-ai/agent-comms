# CI scope

`Check` runs for pull requests and pushes to `main`, not feature-branch pushes.
Both existing check names remain: `check (ubuntu-24.04)` and `check (windows-2025)`.
Each runs the small CI-helper tests and classifies the complete Git diff before
installing application dependencies. PR classification uses the merge base and
PR head; documentation validation reads the checked-out merge commit so combined
base/head edits are checked before merging. The base-tip-to-merge diff also must
qualify as docs-only and supplies validation paths after base-side renames. Pushes use the event's before/head
revisions. Missing history, unknown
events/statuses or an empty diff select full CI.

Only `README.md` and Markdown files under `docs/` qualify as docs-only. Both sides
of renames must qualify. Mixed changes, `validation/`, package READMEs, source,
dependencies, build scripts and workflow changes keep the full existing checks.
The release workflow is unchanged.

Docs-only changes run Git whitespace checks and check changed documents for
unclosed fenced blocks and invalid complete `json` examples. Ubuntu additionally
uses `bash -n` for complete `sh`/`bash` examples; commands are never executed.
Explicit closing fences are repository policy, stricter than CommonMark, which
also permits a fenced block to end at EOF. This is a bounded scanner, not a full
Markdown parser.
These checks require no application dependency installation. Other fence languages,
indented/nested code blocks, links, Markdown style and example runtime behavior
are not validated. Use a `text` fence for deliberately incomplete/pseudocode
examples; do not relabel runnable code to hide a validation failure. If Markdown
becomes a runtime/test input, remove that path from the allowlist or add its
explicit fixture check before allowing it to skip full CI.

Classification failures fall back to full CI; documentation validation failures
fail the job. There are no workflow-level path filters or skipped matrix jobs, so
the same check names report actual results for docs PRs. No branch protection is
configured by this workflow. Test the helper with `node --test scripts/ci-docs.test.mjs`.
