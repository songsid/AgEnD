# R1 — stale runtime paths are not manager socket loss

Review found that both inspected paths could come from a stale `XDG_RUNTIME_DIR`. `user@UID.service` being active did not prove that these were its sockets. The helper now requires the configured private path to match the canonical per-UID path from the existing `privateSocketPath` helper before it can call both sockets missing. A mismatch returns `unavailable` and inspection advice, with no restart command. The stopped-manager branch and approved EN/zh-TW text are unchanged.

Two pure regressions (canonical sockets intact / configured paths unverified) fail on `08aaf56b` before the fix, then pass. Real-source CLI fixtures now model the canonical socket reads through a child-only `existsSync` override of exactly those two paths, alongside the existing fake systemctl; they never write host `/run`. EN/zh-TW CLI controls cover both genuine socket loss and stale runtime variables with intact canonical sockets.

The initial CI failure was two exact call-list expectations in `install-auto-enable`: the new read-only `--user is-active com.agend.fleet.service` occurs before reload. R1 adds that call to the expected lists; every existing reload, loaded-unit/NotifyAccess repair, enable and file assertion remains.

- **142/142 across 6 focused files**, including `install-auto-enable` and the **18** diagnostic cases.
- Both native TypeScript projects pass.
- **13/13** independent reversals fail assertions, including omission of the canonical-path guard (**4** failures). Exact source restored; **18/18** diagnostic cases pass again.
- Safe main container rehearsal rerun with the R1 helper: the real canonical socket-loss case still diagnoses correctly, inert service survives diagnosis, printed manual steps restore both sockets and replace the inert process. Same non-privileged/network-none/private-namespace/binfmt safety and Ubuntu22 consequence-only scope as R0. No real Fleet/agent/account/pilot/directory operation.

`receipt.json` binds the pre-commit R1 modified product/tests/harness over `08aaf56b`. R0 receipts/transcripts remain historical; they are not relabelled as R1 execution. Logs normalize only the workspace/fixture prefix and trailing blank lines. No copy or authority change; no automatic repair, extra timeout or parked #2882 work.
