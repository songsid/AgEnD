# M-3454 / S-204 — opt-in settings foundation

Current scope: configuration, persistence and gates only. **The monitoring card is not rendered until the collector capability is exactly true.** The actual server capability remains false in this slice. The Notifications lead and search registry match dev98cfd9b77 byte-for-byte, so a beta cut between slices has no dead feature to click. The Leader removed this slice's user-capture gate; final real-data UI approval remains S-207/S-209.

## Behavior and boundary

- Missing flags normalize to literal false; explicit saves write both booleans to fleet.yaml, retaining false across repeated real writer saves and preserving unknown configuration.
- Strict parser rejects null, arrays, unknown fields and non-booleans. Planner and handler share it; admin/continuation/transaction rules remain. A failed save restores memory.
- The dormant card uses shared Settings rows, switches, hints, drafts and off confirmation. Its capability wrapper returns null without a collector and unstages hidden edits; the controls mount in a separate child so hook order stays stable. No unsupported-version warning or placeholder card is drawn.
- Both planner and handler refuse enabling while the collector is unavailable. No monitoring provider, timer, worker, history file, notification sender or host probe is installed. Existing cron is untouched.
- S-205 connects bounded platform lifecycle only after S-204 actually merges; it must pin absent defaults durably before provider startup. S-206 history/cleanup, S-207 page, S-208 alerts, S-209 agent sampler and required one-hour measurement follow in unstacked PRs.

## Current R1 proof

The Leader requested hiding the dormant feature rather than shipping disabled-looking switches. Six semantic UI cases failed on f8ac18faa: unavailable/missing/malformed capability values, a configured-on host without capability, and capability loss with a staged edit. Prism then found that cancelling disable left the native checkbox visually off while its draft remained on. Two added DOM assertions (staged-on and saved-on) failed before the fix. Cancel now restores the displayed checked property; confirmation still stages explicit false. The final combined repair passes107tests in4files with one worker and terminal exit0; its10 UI cases cover both visibility and Cancel behavior. The test type checker has zero diagnostics. An intervening parallel verification hit two10s Settings integration timeouts and three dependent missing-control assertions; the unchanged file passed43/43 alone, followed by the full107/4 serial pass. No timeout was increased and no product change was made for the runner failures. Notifications lead and registry are byte-equal to the actual dev base. Config/parser/API/planner implementation is unchanged from f8ac18faa.

No new browser campaign is needed for a hidden card with unchanged surrounding DOM/styles. Previous original images below are **superseded** and cannot be treated as the current UI. User approval will cover the actual functioning page at the later slices, per the Leader.

## Historical source-stage evidence

| Superseded f8ac18faa view | Original |
| --- | --- |
| Desktop EN, light — card was still visible | [Historical Settings](actual-settings-desk-en.png) |
| Phone zh-TW, dark — card was still visible | [Historical Settings](actual-settings-phone-zh.png) |

These two blobs remain unchanged and were individually inspected public-safe at that source stage. Scratch FleetManager served the actual app with one synthetic General, no agents started and no DOM/CSS/metrics overrides. The raw fixture lacked a monitoring section; its effective settings were false. Explicit persisted false is proven separately by the real YAML writer test. They are not current hidden-card captures or real host telemetry. The fourteen original M-3441 design images in the other evidence directory are also historical/inert.

Earlier checks carry only their unchanged scopes: configuration base9red then9green; focused56/4; integration179/7; metadata77/2 after frontmatter correction and reverting an unnecessary concepts edit; two caught faults and restored25/2; source/test TypeScript0diagnostics. Plain-merged actual dev98cfd9b77 (#4236), preserving its Classic picker. The pre-R1 eighteen-path added/removed multiset matched the original implementation patch; R1 intentionally changes UI visibility and reverts two files to base. Current hashes are refreshed rather than claiming whole-file equality across that repair.

The merged source stage completed72/3 tests with terminal0 and the Settings CI matrix124/124 in44s with terminal0, no allowance changes. Earlier background runners reported all assertions passed then returned143; their signal origin was not established. Foreground/non-login runs resolved terminal uncertainty without a product fix, timeout increase or native campaign. R1 has its separate current tests above.

## Pending acceptance and rollback

Prism exact-head review, current CI, coordinator merge and post-merge green remain required. Full runtime behavior, native platform acceptance, the one-hour both-options-on measurement and final real-data captures are later slices. This foundation creates no history and does not replace the cron watcher. Revert its source additions to roll back; saved false remains inert in older builds.
