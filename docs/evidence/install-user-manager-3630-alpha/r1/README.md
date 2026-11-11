# R1 alpha parity — canonical manager paths

Alpha carries main #3631 R1 (`8ac717bd62fdb3315fc0c02f0af0f009d8de0aa4`) without an own logic change. The earlier alpha-only `preservePidFile` conflict resolution remains. The receipt compares every own added/deleted product/test/changelog line against main, and binds the clean product/test candidate `62d01656e` over alpha `9abdfa67f`.

- Original alpha source: four expected assertion failures for the active/missing and stopped branches. The unchanged guard-free alpha helper also gives **2 fail-first** stale-runtime assertion failures. These are recorder/isolated-HOME fixtures, not host operations.
- **142/142 in 6 focused suites**, including both exact activation sequences from main's CI repair, plus both native TypeScript checks.
- **13/13** reversals caught; removing canonical-path binding gives **4** assertion failures. Exact source restored, **18/18** diagnostic controls pass. Canonical socket existence is modeled only inside CLI child processes; host `/run` is never written.
- Main's fresh [R1 safe systemd consequence/recovery rehearsal](../../install-user-manager-3630-main/r1/README.md) remains main-scoped. Identical helper/diagnostic patch; no alpha container rerun or WSL kernel-bug reproduction claimed. No real Fleet/agent/account/pilot/directory operation.

Configured non-canonical runtime paths return unavailable/inspection, not a restart command, even with intact canonical sockets. Genuine canonical loss retains approved EN/zh-TW manual recovery. No automatic repair, unit/workflow/timeout change or parked #2882/M-2181 work. Same code-revert rollback and no schema change.
