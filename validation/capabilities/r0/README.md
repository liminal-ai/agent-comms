# Capabilities R0: the contract

Failing tests were committed or captured before each behaviour, then the behaviour; raw output here.

| File | What |
|---|---|
| (commit 184b6ae) | protocol contract tests, failing: 9 of 11 |
| `unsupported-before.journal.txt` | the new ops against the stub (it hung: no case for them) and the connector (no handler), before the fix |
| `unsupported-after.journal.txt` | stub 21/21, connector 15/15: every new op answers `unsupported` (501); `send` with `wait` is refused, not sent unwaited |
| `convex-before.journal.txt` | the web-view Convex functions: 8 of 8 failing before the schema and functions existed |
| `convex-after.journal.txt` | 8 of 8 passing |
| `cli-exit-before.journal.txt`, `cli-exit-after.journal.txt` | the CLI's exit codes come from the protocol's `CLI_EXIT` |
| `pnpm-check.journal.txt` | the whole repo: typecheck (every package, the mod's protocol copy, the web app) and every test suite, exit 0 |

`../sanitize-check.mjs` scanned every file here: 0 credential values.

`convex/_generated/api.d.ts` was updated by hand in codegen's exact form (codegen needs a deployment, and pushing unmerged code to the live local one would deploy it); the push after merging regenerates it.
