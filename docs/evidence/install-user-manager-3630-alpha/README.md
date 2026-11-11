# #3630 / M-2882 — alpha parity

The product/test inputs were tested at the unpublished alpha candidate `600b3b9c2` over `9abdfa67f3d21734d5584ea6b188dd441e8877a0`. `receipt.json` binds every input and verifies that each own added/deleted product/test/changelog line equals main #3631's `08aaf56bf8129d8241193b70a1e8db2bbbc6aa8e` patch.

The cherry-pick conflicted only at `activateService`'s signature. Alpha's existing `options.preservePidFile` parameter and its PID-preservation behavior remain; the same Linux diagnostic preflight is inserted before that section. Alpha's Background Hub launchd/domain behavior stays as it was. The new helper and regression test are byte-identical to main.

- Original alpha `9abdfa67`: **4 assertion-red** real-source CLI cases with a recorder `systemctl` and isolated HOME/data. No fixture/loader failure is counted.
- Candidate: **133/133 in 5 focused files**, both native type checks, changelog validation.
- **12/12** individual guard reversals cause assertion failures; exact source restored and **14/14** new tests pass. Mutation input bindings match this candidate.
- Main's EN/zh-TW output and safe real-systemd consequence/recovery rehearsal remain [main-scoped evidence](../install-user-manager-3630-main/README.md). No alpha container rerun or reproduction of the WSL kernel bug is claimed. No real Fleet, agent, account, pilot or directory operation.

Same risk/rollback as main: an unverified connection refuses activation after writing the unit; recovery is manual, with an interruption warning. A revert restores old diagnostics. No schema migration, automatic restart, workflow change, retries/timeouts, unit directive change or parked #2882/M-2181 implementation.

Current R1: [canonical-path correction and fresh alpha controls](r1/README.md). R0 evidence retains its original execution scope.
