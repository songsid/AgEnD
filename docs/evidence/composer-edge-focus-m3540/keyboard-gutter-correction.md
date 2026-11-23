# Keyboard gutter correction (main first)

Dev twin #4359's attempt-1 keyboard-suite job137577494420 failed the existing WebKit motion smoke: the composer left a 16px band while the simulated keyboard closed in blur-first order, in both locales. The added strip's 8px bottom padding stacked with the dock's existing 8px bottom padding. No retry or timeout change fixes this geometry.

The strip now uses a negative bottom margin of the same 8px token, consuming the dock's existing empty padding instead of adding another gap. Its full hit gutter remains present, inside reserved dock space; no message-list overlay or neighboring-control interception is added. The helper, strip scope, controls, keyboard motion algorithm and thresholds are unchanged.

The existing motion harness, limited to one phone/light/English case in local Chromium with its simulated iOS viewport, reproduces the baseline 16px violation and passes after the one-rule change. Both open/close event orders are checked. `worstBand:0` means no over-threshold frames, not a measured zero raw gap. Original 12px acceptance and all timings remain unchanged. This is not a native keyboard or local WebKit run. Fresh dev CI must supply WebKit coverage.

The main regression fails one assertion on the merged main base, then all16 composer cases pass and test typecheck has zero errors. Main's gutter declaration is identical to the locally checked dev patch. The original four PNGs/source records remain historical; the user waived further screenshot rounds. Diagnostic motion frames stayed private and were not added to the public capture set. No original broad browser/native/provider campaign was repeated.

Proof: `keyboard-gutter-control.json`. This main-first correction precedes the pending dev twin's new fixed head. Rollback reverts only the gutter margin; no data migration.
