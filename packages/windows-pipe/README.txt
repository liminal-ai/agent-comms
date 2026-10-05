Native Windows comms candidate (draft PR, 2026-10-04)

Scope
Based on v0.1.1, cc758ce91a170f9b6e5e9977e5fa6c55b714c086. Native Windows support is a reviewed candidate, not a published release. No deployment or registration is performed by the test workflow.

Implementation
listenLocal selects the original Unix socket sequence or a Windows named-pipe bridge. Pipe creation uses a protected current-user DACL, first-instance and reject-remote flags. Both peers verify process user SID. Managed helper frames provide concurrent streams, backpressure, typed connection errors, and lifecycle failure propagation. CLI connections are pooled. The identity boundary is the normal Windows user, not every process/account on the machine.
Windows credentials are read through a handle-based owner/DACL/plain-file validator on startup and on each T3 adapter bearer read. Other-principal allow ACEs are rejected. Standalone Windows Claude hooks explicitly remain off because the host's private stdin transport is unverified. T3-hosted providers use the existing T3 adapter instead. No sandbox-user grant or broker is implemented.

Runtime
Use native Node24 per package.json and PowerShell7. Set AGENT_COMMS_POWERSHELL to an existing trusted absolute pwsh.exe path; absent that setting, the standard ProgramFiles PowerShell7 location is used. PATH lookup is intentionally not used. Keep all C#/PowerShell companions beside bundled entry points. Runtime installation and credentials are separate operational actions.

Verification
pnpm typecheck
pnpm test
pnpm test:release
pnpm build:release <unique-local-version>
Root tests include test:windows; native tests skip on other platforms. Windows checks cover restrictive descriptor construction, interoperability, concurrency, large payload, CLI restart/retry, helper lifecycle failures, and credential ACL validation. Two POSIX-only directory-security cases are excluded on Windows; Unix execution has not been verified here. Other-user/remote denial and live staging exchanges are separate acceptance tests.
The native secret fixture uses a fresh FileSecurity descriptor with FileSystemAclExtensions.SetAccessControl, based on a reviewed passing disposable fixture. This avoids Get-Acl/Set-Acl requesting SeSecurityPrivilege. The shared privateFixture helper creates only disposable temp dummy-token files and bounds its DACL helper to that fixture path. Actual credentials/security settings are never adjusted by these tests. The adapter HTTP classification fixture and release auth-binding fixture use this helper.
The release directory-link launch fixture uses a directory junction on Windows and a symlink on Unix. Both exercise realpath-based launch without requiring Windows symlink privileges. The original deployed review5 baseline had an EPERM failure here; the follow-up fixes the fixture without changing machine policy.

Operational limits
The native CLI works as the current user; separate Codex sandbox identities cannot use its pipe. Model sandbox permission failures are unaffected. Standalone Windows Claude hooks are disabled. Live installation/startup, private real credentials, new machine registration, participant promotion and named-peer testing require their own authorization and operator flow. Do not run the generic setup utility just to register one machine: it also performs broader upgrade/group operations.

Reproduce from source
Use the draft PR branch local/windows-arm-comms-review-20261004 in the private liminal-ai/agent-comms repository. The original deployed review5 source is preserved at 9fd3ca70b9e9286f5befc1e35a20536ce78fe5ab; follow-up commits improve readiness and do not change an installed connector automatically.
After fetching and checking out the selected exact commit, run pnpm install --frozen-lockfile, set AGENT_COMMS_POWERSHELL to the installed absolute PowerShell7 executable on Windows, run pnpm check, and build with pnpm build:release <unique-version>. Then run node packages/windows-pipe/test/bundle.mjs <unique-version> on Windows. All helper companions must remain beside the bundled entrypoints. No live credentials, registration or cloud deployment are needed for these local fixture checks.
CI runs the aggregate checks and build on Ubuntu and Windows x64; ARM64 checks are run on the VM. Do not treat x64 as passed until its job succeeds.
