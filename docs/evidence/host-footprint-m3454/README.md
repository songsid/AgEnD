# Optional agent footprint: S209 acceptance evidence

M-3454 / S-209 adds the separate, off-by-default agent option to the existing Host health page. Both saved switches must be on. Disabling the parent cancels and physically drains the process reader before clean Off. Cached admin handlers never collect.

The implementation attributes numeric CPU/RSS and exact known output-log metadata to cached, launch-bound roots. It caps roots at 128, rows at 4096, process output at 512 KiB, the whole flight at two seconds, and concurrent metadata/kernel reads at eight. CPU is normalized to total computer capacity; RSS may count shared pages twice. Shared services are separate, unknown agent trees are quarantined, and workspaces are not measured. History shares the existing physical cap: agent raw data up to six hours, rollups up to seven days, with at most 50 displayed rows and one selected agent's CPU/RSS history per view.

## Real one-hour measurement

[Numeric summary](measurement-summary.json), [window scope](native-window-scope.json), [cleanup](cleanup.json), and [final arithmetic replay](birth-ceiling-replay.json).

| Combined monitoring + footprint | Observed |
|---|---:|
| Elapsed | 3,600,132 ms |
| Process samples / host observations | 60 / 119 |
| Populated agent CPU and RSS buckets | 59 each |
| CPU, one-core basis | 0.113% |
| CPU, total capacity (six logical CPUs) | 0.0188% |
| Peak Node RSS | 134.5 MiB |
| Charged storage writes per hour | 13.85 MiB |
| History physical accounting | 4.18 MiB |

This is one owned real idle Node process tree, actual host collectors, and production SQLite/incident storage in an isolated source-runtime rig. No live Fleet agent, CLI, account, model, tmux or notification was started. It does not establish macOS-native costs, a busy Fleet, or a 32/128-native-agent workload. CPU covers Node/history worker threads and reaped process-reader CPU; peak RSS excludes child-process peaks and separate source-loader processes. Combined-on cost is not an isolated incremental footprint measurement. Linux `write_bytes` is charged storage writes, not device writes; cancelled/delayed writes differ. See the [kernel accounting documentation](https://docs.kernel.org/filesystems/proc.html#proc-pid-io-display-the-io-accounting-fields).

Earlier incomplete windows remain failed controls. The instrumented third window caught the same owned live process's ps epoch presentation changing by one second. Linux now pins kernel start ticks instead of that presentation. The accepted window again observed a one-second ps epoch change while keeping the same kernel identity and full coverage. Root birth age remains separately fenced.

One arithmetic-only correction after the accepted window began made the birth precision bound conservative by rounding boot/tick uncertainty upwards. Commands, reads, cadence, pins and history were unchanged. All 60 actual numeric input frames were replayed through the **final production binder and attribution policy**; every admission was identical, minimum margin 548 ms. This is admission equivalence, not a second CPU measurement or a claim that final source bytes ran for the entire hour. The reconstructed pre-correction module is not misrepresented as a captured pre-launch hash. [Current source hashes](source-inputs.json) are explicitly post-window review inputs. Public artifacts omit raw process IDs and disk identities.

## Checks

- Related host monitoring/history/alerts/platform/Settings/API/route/skill suite: [306 tests across 33 files](kernel-final-suite.log). The final [40 tests across five affected files](birth-ceiling-tests.log) include two additional regressions, for **308 distinct tests / 33 files** with unchanged test scope carried forward.
- [16 sidecar compatibility tests](sidecar-carry.log) also pass: **324 distinct tests / 34 files** in that combined scope. No repeated native/account campaign.
- [37 UI/i18n tests across three files](final-ui-time.log) pass; these overlap the related suite and are not added again to the count.
- [Final production build](ready-build.log) and [test TypeScript check](ready-test-types.log) exit zero. [Phone/shared-query and footprint UI checks](phone-table-checks.log): 9/2 pass after the scoped phone spacing change. [Runtime assets](final-assets.log) regenerated successfully.
- Existing isolated reversals caught off-timer work, premature physical reservation release, nearest-root attribution and birth-observation guard removal. [Kernel identity reversal](kernel-epoch-mutant.log) catches returning to ps epoch pins. Production inputs were restored.
- [Whole Settings CI gate](settings-gate.log): **124 checks pass**, all sections desktop/light/EN and phone/dark/zh-TW plus middle-width and long-value checks. No tap allowance added. It ran before the final phone-only `.host-footprint` cell-spacing correction, which cannot affect Settings; the affected Health page was then rechecked in the real browser for no page/table overflow and 44px phone controls.

Commands are reproducible in [the manual rig](../../../scripts/manual/host-footprint/README.md). Raw measurements remain private. Validation requires an hour, at least 59 process samples, 119 host observations, 55 populated agent-history buckets, live coverage, recording history, and physical cleanup. No retries or guard weakening make incomplete windows pass.

## Real-app before / after

[Gallery](gallery.md). All eleven current originals were visually inspected. The new phone table initially clipped its last value and was corrected. A later Leader-requested zh-TW polish keeps the memory header together, removes the coverage separator, uses consistent 取樣/middle dots, and simplifies the Settings hints. Six scoped originals were captured: desktop/phone Health and table details, phone Settings, and the additional phone Host-alerts empty state. Desktop Settings is unchanged; its earlier asset binding is retained rather than claimed to be the later bytes. The four baseline originals carry unchanged. [Polish tests](polish-tests.log) pass 33/4; [assets](polish-assets.log) regenerate successfully. Runtime/collectors/policy/worker/history, the accepted hour and native proof are unchanged. The Settings gate carries; no broad or native repeat.

Before views serve the clean earlier app at `5fa950d6` (its UI blobs equal the actual base `930b0a87`). Candidate views serve the candidate checkout. Both use the same completed host cache. Settings seeds raw/effective scratch configuration consistently; the first capture attempt's mismatch was rejected by the checked-switch assertion and is not presented as evidence. Resource response hashes are in [before inputs](before-inputs.json) and [after inputs](after-inputs.json). The after-view footprint uses the production snapshot stale check, without freshening sample times. No browser collection, clock override or fabricated workload is hidden in these views.

Counters, timestamps and history are actual retained data; helper names and opaque volume IDs, including incident keys, are synthetic aliases. The helper has already stopped. Empty alert acknowledgment copy, zh update-colon spacing, and explicit start-age wording are the three deferred S208 nits, covered by mounted UI tests.

**USER LOOK HOLD:** draft until the new final captures are approved. Earlier page/alert approvals do not release this PR. Risks: sampled short-lived processes may be missed, RSS is an estimate, and macOS has portable ps identity rather than Linux kernel ticks. Rollback: turn the footprint switch off; parent monitoring and existing alerts retain their separate switches. Remove this slice to restore the reserved/disabled footprint UI; YAML remains only the two compatible booleans, with the drive sidecar unchanged.

The added phone empty-state image shows the actual completed window's zero active alerts. Its capture asserts that neither the acknowledgment explainer nor a last-update line exists. It therefore proves the empty-state behavior, **not** spacing after a nonexistent update colon. The mounted active-case UI regression proves no ASCII space after 「問題最後更新：」. This distinction avoids fabricating an active incident for a real-data empty capture.
