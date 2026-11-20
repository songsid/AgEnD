# Synthetic 80-entry scale check

This scratch roster has 60 Fleet instances and 20 ClassicBot rooms; 40 entries are paused and 40 running. Several names are intentionally long. No real roster, host identities, account data or provider calls are used.

## Result and change

The original 50vh status box had no horizontal overflow and rendered quickly, but its 80 rows required about 14 box heights on desktop and 38 on phone. That is too much browsing without navigation; simply making the box taller would still leave a long list.

The current report adds a visible count and paused summary, a filter across name/backend/model/state cells, and Open report using the shared Dialog. The dialog keeps its title, 44px phone close control, filter and count visible while only the report body scrolls. Filtering a room returns exactly 1 of 80 without another command request; clearing returns all 80. The desktop name column has more room.

The inline desktop body stays at 50vh; the phone preview is 25vh so the composer remains visible. Open report provides the larger reading surface. Grouping/pagination is not needed for the measured render cost, and the filter handles finding an entry or state.

Sysinfo remains 13 metric/version rows regardless of roster size. Its running/paused totals change to 40/40; Open report makes the lower version/resource rows easy to reach.

## Measurements

Command-to-painted-report elapsed time includes the two UI clicks, loopback request, collection and two animation frames; it excludes screenshot time. These are four scratch Chromium samples per command (desktop/phone, EN/light and zh-TW/dark), not a hardware benchmark.

- Status: 146–201 ms for 80 rows.
- Sysinfo: 123–160 ms for 13 rows.
- All eight command routes returned 200; every status response had six columns and 80 rendered rows.
- No page/report/modal horizontal overflow. Every phone Send button stays above the bottom navigation. Every expanded close control stays within the viewport even at the last row.
- Filter persistence across opening/closing the dialog, clearing, empty results and no additional command/message are pinned by a mounted regression. Its base fails; the final web-chat and style suites pass 66/66. Test types pass.
- Before/final image review covered four baseline views, all eight final principal reports, filtered phone, expanded phone start/end, and desktop expanded. The final phone close-size correction was re-inspected in three modal views. The remaining captures have automated checks only.

## Captures for the visual decision

- [Desktop status](after/desk-light-en-status.png)
- [Desktop sysinfo](after/desk-light-en-sysinfo.png)
- [Phone status](after/phone-dark-zh-TW-status.png)
- [Phone sysinfo](after/phone-dark-zh-TW-sysinfo.png)
- [Phone filtered to one room](after/phone-dark-zh-TW-status-filtered.png)
- [Phone expanded status](after/phone-dark-zh-TW-status-expanded.png)
- [Phone expanded final row, controls retained](after/phone-dark-zh-TW-status-expanded-end.png)
- [Phone expanded sysinfo](after/phone-dark-zh-TW-sysinfo-expanded.png)
- [Desktop expanded status](after/desk-light-en-status-expanded.png)

Both locale/theme/device pairs and corresponding end views are retained alongside the original baseline.

## Limits and rollback

This verifies synthetic collection/rendering and navigation, not model/account behavior or timing on other machines. The source collectors, admission rules and six-field web projection are unchanged by this scale adjustment. No Access settings change is included. USER VISUAL HOLD remains; a fresh exact-head review/CI and approval are required.

Revert the scale adjustment to restore the earlier report presentation; no data migration or account/profile change is involved.

## Focus correction

Review found that opening the dialog removes its original trigger, so the shared dialog cannot restore that detached node. A local ref plus layout effect now focuses the recreated Open report trigger only after closing an expanded report. It does not change the layout or the captured report content.

Both Close and Escape cases fail on the reviewed head at the activeElement identity assertion; both pass with the correction, retaining the filter, clearing/empty-result behavior and the single-command/no-message assertions. Only these two mounted cases were rerun; no broad source/browser campaign or capture replacement was needed.
