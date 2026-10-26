# Windows install-drive choice (#2712)

The user removed their `AgEnD` distro because it was installed on C:. The subsequent installer correctly offered a new install; this was **not** a distro-list/reuse regression. The blocker was the removed drive-choice menu. This change follows the already-live path fix #2711 as a separate PR.

## Behavior

- Two or more local drives with at least 5 GB free: show a numbered drive/free-space list. The existing `Select-InstallDrive` recommendation is marked as default: system disk with at least 20 GB, otherwise the roomiest eligible disk. Enter accepts it; invalid/out-of-range/overflow input is re-asked.
- One eligible drive: use it without asking. None: stop with a space-recovery instruction.
- `$env:AGEND_WSL_DRIVE = 'D:'` before the one-liner skips the drive menu for a fresh planned install. The closed grammar accepts a drive letter, `D:`, `D:\` or `D:/`, normalizes it, and rejects paths and shell syntax. A missing/nonlocal/full requested disk stops instead of silently picking C:.
- Bootstrap validates the override before download and passes `-WslDrive` through both Windows Terminal and conhost elevation. The installer saves it before any reboot point; RunOnce reopens the same progress file, so no new RunOnce command length is needed.
- The exact full location is written as `WSL_INSTALL_DISTRO` and `WSL_INSTALL_PATH` **before** distro download/install. Retries keep it even if free-space rankings change; an unavailable saved drive stops. A different override does not move an already planned or installed distro. Existing distro reuse is unchanged.
- When the progress file's **previously installed** `DISTRO` no longer exists in the current verified registration list, discard that target, completed stage-1 marker, saved override and saved location. Restore the normal fresh Ubuntu target, preserve backend/version progress, and let the user choose again. An unknown registration list changes nothing. A not-yet-created planned location has no completed `DISTRO` record and remains resumable.
- The progress reader now accepts an empty file; clearing the only stale target lines must not throw on a null `Get-Content -Raw` result.

The switch affects WSL installation, before npm/AgEnD. It changes no package version default, runtime API, login account or existing distro location. It never unregisters, removes or migrates a distro.

## Doubled Chinese banner

`Get-WslDistroNames` no longer sets/restores `[Console]::OutputEncoding`. WSL output is captured in pipes, and the child already receives `WSL_UTF8=1` plus explicit UTF-8 decoders. Changing the shared console was unnecessary.

[.NET Framework's setter](https://github.com/microsoft/referencesource/blob/ec9fa9ae770d522a5b5f0607898044b7478574a3/mscorlib/system/console.cs#L594-L646) calls `SetConsoleOutputCP` and rebuilds console writers; [Microsoft documents](https://learn.microsoft.com/en-us/windows/console/setconsoleoutputcp) its effect on character-to-glyph mapping. [WSL 2.6.1](https://github.com/microsoft/WSL/blob/642331364dda7a3d88bf64acb87e7056918a5fc9/src/windows/common/WslClient.cpp#L1850-L1859) selects its own output encoding from the child environment. The regression test checks the parent's encoding **during** the probe, not only after restoration. This removes a confirmed rendering side effect; exact duplication on the affected PC remains a user retest, not a claimed native reproduction.

## Validation and boundaries

- Private networkless PowerShell 7.4.2/Node22.22.2 container, 1CPU/1GiB, scratch HOME. WSL, registry, downloads and elevation are stubbed/forbidden. The elevation tests execute only owned inert scripts under a second pwsh.
- New drive tests cover the default/menu/single-drive cases, invalid choices, unavailable/invalid overrides, persisted location, stale removed distro, the real saved-stage guard, environment-loss/Force, and parent console encoding.
- Existing version-pin/elevation tests retain their original assertions and additionally verify the drive reaches both elevation routes. Existing WSL-root/reboot tests retain their shutdown/consent boundaries.
- Changed-line mutations cover always-auto drive choice, ignoring saved location, and ignoring removed target. Mutants are restored afterwards.
- Both actual published npm **2.3.1** and **2.3.2-beta.11** accept the current generated readiness program through their actual inert auth handlers; their previously verified CLI/capability contract is unchanged. The change adds no AgEnD CLI flags or package-specific file expectations. No default-to-beta change is needed.

No real Windows desktop, WSL distro, fleet or account is exercised. In particular, this is not a claim to have tested physical drive selection or visual CJK rendering on Windows.

## User instruction / rollback

After Pages publishes the fix, rerun the same one-liner in the same Windows account. Choose the other drive in the numbered list, or first set `$env:AGEND_WSL_DRIVE = 'D:'`. Their removed AgEnD target is cleared automatically; their existing Ubuntu is untouched unless they explicitly choose to reuse it. No additional deletion is requested.

Rollback reverts this PR and restores automatic drive selection. Its new progress keys are ignored by older scripts; no runtime config or database is migrated. The old path fix #2711 remains independently deployed.
