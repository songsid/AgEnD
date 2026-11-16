## Scope

M-3224 worker transport layer, following #4040. Dedicated local binding, authentication-only staging, effective-profile preflight, final-result transport and ordinary-Runtime separation. Unmounted: no production command, installer, Hub route, personal agent or Ready state is offered here.

## Verification

`vitest run tests/runtime-personal-stage-m3224.test.ts tests/runtime-personal-preflight-m3224.test.ts tests/runtime-personal-profile-m3224.test.ts tests/runtime-client.test.ts tests/runtime-coordinator.test.ts tests/windows-cli.test.ts --maxWorkers=2`: 151 passing. Source and test TypeScript programs pass. Fixtures use synthetic auth, an inert child and real loopback Coordinator/Client protocol. Two new guards first failed: the missing non-command feature disables, and an answer arriving after a worker error. They pass after the fixes.

The Windows profile workflow runs the real pinned Codex/Claude binaries on a disposable hosted runner, with synthetic authentication, local sandbox commands and help/prompt rendering only. Its result is pending at initial draft publication; no real enforcement or live provider claim is made by the unit results. No user Windows/WSLg window, account, Fleet or provider call is used.

Review repair: access-only OAuth staging refuses credentials with less than six minutes remaining. The seven staging cases pass; four targeted reversals are caught (Codex refresh copy, Claude refresh copy, and each expiry guard). Codex 0.167's local parser was checked with synthetic OAuth data: omitting the required refresh-token field is refused; an empty string parses as ChatGPT auth without passing refresh authority.

Platform discovery: the hosted Windows Server default refuses restricted reads without its elevated sandbox. The profile now explicitly selects MXC and a pre-turn sandbox startup check; it never requests legacy provisioning. The product owner accepted unsupported Codex hosts failing closed, with Claude evaluated separately, and the leader confirmed Windows 11 as the primary target.

The [Windows 11 proof run](https://github.com/songsid/AgEnD/actions/runs/43825192077) passes all eight controls at runtime source `7b8966a7a3f09c03ef499cf3e8ce2ca85bb08d1a`. It ran on Windows 11 Enterprise ARM64, base build `10.0.26200`, image `windows-11-vs2026-arm64/20261112.217.1`, with Codex package `0.167.0` and Claude package `2.1.325`. Its checks cover effective flags/prompt, access-only OAuth parsing, shared read, outside and junction read denial, write denial, network denial with a reachable positive control, and Claude help/safety arguments. The final proof script additionally records actual binary versions and the full Windows update revision and checks command denial of staged auth. No x64 Windows enforcement, real login refresh, model answer, full Hub setup or user desktop claim is made by this layer.

## Boundaries and rollback

The profile marker cannot enable a personal binding remotely. Wrong folders, tools, resume and alternate accounts fail before execution. Preview output is empty; only the terminal structured answer crosses after physical exit. Source authentication files are preserved. A bounded failure carries a code, never raw diagnostics. Strict configuration/effective-feature/prompt checks fail closed.

The Hub hosting and UI remain later layers. Revert this unmounted code to roll back; no database migration or accepted work exists. The dedicated hosted proof workflow is removable independently. Skill update is N/A until a production entry point is mounted.
