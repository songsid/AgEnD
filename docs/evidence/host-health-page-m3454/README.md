# Host health page (M3454 / S207)

This slice adds Fleet → Host health for signed-in administrators, backed by the existing cached health and capped-history endpoints. It makes the Settings card/search available because there is now a real destination. Refresh reads cache only. Off does not start collection, open history or poll. The skill and Settings hint describe the actual delivered scope.

**USER VISUAL HOLD:** the leader must obtain approval of the real-data captures before merge. Alerts/incident preallocation are S208. Agent footprint, the hour-long real measurement with both options on, and final approval are S209. This evidence does not claim those are complete. The external disk-watch cron is unchanged.

## Behaviour and limits

- The server's existing administrator boundary remains in force. Read-only browser routes do not load the new lazy page or request metrics; loss of authorization clears metrics and polling. Request generations and the page lease discard late responses. A queued range change keeps the latest selection only.
- WSL CPU/memory are labelled WSL; Linux root/state and the registered Windows backing drive have separate storage rows. An unknown backing drive is unavailable, with a Settings link, rather than a healthy zero. macOS pressure can be unknown and shared APFS capacity is not additive. Ubuntu uses its local fields. Paired Windows Runtimes remain outside these totals.
- Current stale/unavailable values retain age and unknown labels. Charts break at absent samples, show minima/peaks/coverage, accept zero, and render at most 240 buckets. Low-water/history failures keep current cached metrics available.
- The tab uses shared Fleet navigation, PageHead, card/button/notice/status components and token CSS. Phone storage is first; CPU and memory sit side by side below it. The expanded Fleet tab inventory uses the full separate row; late administrator tabs scroll the active selection into view.
- S205's command stdout budget and deadlines are unchanged. A real-data capture found the kernel mount inventory was 34,222 bytes/153 records and exceeded the old 32 KiB cap. Only that fixed kernel-file read now admits 64 KiB, with a fail-closed 512-record cap; command outputs remain 32 KiB. Three failing controls pin the boundary. No recursive filesystem scan or new native command was added.

## Evidence scope

The real views use an isolated scratch FleetManager and the actual bounded monitoring runtime plus existing cheap memory sampler, without Fleet admission/notification callbacks. No Fleet/CLI start, account, model request, cron edit, or recursive state scan occurs. The history worker receives actual WSL samples on its normal cadence. Disable waits for physical Off and history cleanup, then closes the owned listeners/browser. Raw snapshots and volume identifiers stay private. The sidebar is a synthetic stopped helper; no real agent roster is exposed.

macOS, Ubuntu, unknown/stale/low-water and unsupported captures use explicitly synthetic platform DTOs in the real application shell. They prove rendering, not native macOS/Ubuntu measurements. Their chart values are derived from the displayed synthetic snapshot, not an unrelated fixed byte value.

The initial 21-view batch passed page checks and privacy inspection, but visual review found a clipped active tab, verbose phone header, and missing lower-resource views. Only affected populated views were retaken; unchanged Settings/off/unsupported views carry. Full Settings `GATE=ci` passed all 124 checks once; no allowance changed.

Verification commands/results and the bounded screenshot index are recorded alongside this note. Local full suites and provider campaigns were not run. Reverting this slice returns the page capability to false, so the existing Settings/search gate hides the card while S204–S206 remain dormant by default; no user's monitoring state is silently enabled.

## Verification

- `vitest run tests/host-health-*-m3454.test.ts tests/host-monitoring-mount-budget-m3454.test.ts tests/host-monitoring-platform-m3454.test.ts tests/host-monitoring-runtime-m3454.test.ts tests/host-monitoring-settings-ui-m3454.test.ts tests/fleet-docs-link-1844.test.ts tests/fleet-tabs-header-2542.test.ts tests/nav-trim-2183.test.ts tests/phone-landscape-m3254.test.ts --maxWorkers=1`: baseline 91 tests in 11 files passed. Subsequent cached-pressure and async-tab regressions add two distinct cases: 93 distinct across those 11 files, not the sum of reruns. The final affected layout set passed 29/4; restored UI/route passed 18/2. Logs retain these stage boundaries.
- Eight semantic guard reversals caught real assertions and restored exact inputs: readonly mounting, stale clock, chart gaps, Off polling, kernel budget, excessive mount rows, unavailable pressure, and async tab scrolling. `reversals.json` binds each exact source input and replacement. An initial pressure mutation filter selected zero tests; it was rejected and replaced by a correctly selected assertion failure, not counted as a pass.
- The new kernel-inventory cases fail 3/3 on the old implementation; corrected platform/mount tests pass 14/2. The cache pressure regression fails before its fix. No native CLI/account was invoked.
- `npm run typecheck:tests`: zero diagnostics. `npm run build`: success, including asset/skill packaging. A direct compiler path was unavailable in this linked dependency tree; the canonical npm script above completed successfully.
- Full canonical Settings gate: `GATE=ci` with desk-light-en and phone-dark-zh-TW, 124 checks PASS, zero additions/removals to tap allowances. This was run before the later Host health-only header/tab refinements; unchanged Settings screenshots/gate carry.
- Real-app screenshot checks: 18 current affected originals + six unchanged controls = 24 originals. All current page targets meet 44px on phone, no page errors/body overflow, active tab visible, and the lower-resource phone views assert paired cards. All originals were visually inspected for layout and public privacy. [Gallery](gallery.md), [checks](checks.json).

All native data is from one isolated WSL host. macOS/Ubuntu snapshots are synthetic rendering controls. No native macOS rehearsal, threshold alert, agent-footprint implementation or hour-long two-option benchmark is claimed.

Additional style/CSP/token/input checks: six files contained134 distinct cases; four files passed outright. The locale ratchet flagged internal `setError('admin'/'load')` state codes; the setter was renamed to `setReadState` (no text/output/behaviour change). The affected locale + UI rerun passed; changelog validation then caught missing list-item markers after the metadata correction. The final repository fragment check passes. Failure logs remain disclosed (the long kernel-baseline failure is gzip-compressed). No allowances were added. Capture input hashes bind the pre-rename module; only that internal setter spelling changed afterward, so all images carry without another browser campaign. The final asset packaging ran after the rename.

Leader-requested polish and four replacement real-data originals: [R1](R1.md). Core stage count is now97 distinct; prior93 results carry. No user hold release is implied.

CI fixture-only correction: [R2](R2.md); dictionary + real route16/2 pass with product/UI byte-identical to R1. The initial zero-test VM collection failure is disclosed, not counted as a mutation control.
