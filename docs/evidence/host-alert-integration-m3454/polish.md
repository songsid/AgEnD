# R1 UI polish

The Leader's eight requested wording/time fixes are applied:

- Settings uses the page name 等你處理. Ages use “ago” / 「前」.
- Host samples and incident updates share one compact local 24-hour formatter. Timestamp groups stay intact; the header separator no longer leaves a dangling dot.
- Available-space charts use a whole trend label, including 可用空間趨勢.
- Settings says 使用率（%） and plainly warns that the unchanged disk-watch script keeps sending its own alerts, so enabling General may duplicate them. Off-state wording uses plain language.
- New Settings resource labels reuse the correct full-width zh-TW drive suffix （E:）.
- English Current/Threshold capitalization is consistent. Needs group and card titles no longer repeat “Host alerts”; each card names its resource.
- Memory describes the pressure level and whether it reaches the warning/urgent threshold, or is awaiting recovery confirmation.

Prism's nonblocking filesystem-label ambiguity is also addressed with a short stable six-hex identity on non-WSL filesystem labels. No raw path is displayed.

Three UI cases failed before the fixes; all 74 affected tests in four files pass after them. Production/test types and asset generation are clean. Runtime, coordinator, collectors, persistence, routes, authorization and settings confirmation code are byte-identical to the original source-cleared head. The 214-test baseline and 124-check Settings gate carry with their original scope; there was no new broad suite or provider campaign.

All eight affected real-app views were retaken serially and inspected. No phone overflow, sub-44px targets, new layout issue or private content was found in the captured regions. Actual host samples remain separate from synthetic incident examples. All browser, scratch runtime and worker resources were closed. USER LOOK HOLD remains.
