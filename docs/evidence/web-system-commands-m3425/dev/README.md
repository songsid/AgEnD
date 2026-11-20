# Dev twin integration

Main #4259 merged as 3af9a0b86249cde011bec2f28d4261f25db3995a. This twin starts from alpha 6cde6d563, with the approved report presentation retained. The CommandReport function and report CSS are byte-identical to the approved main version.

Alpha integration keeps the shared chat dictionary, current chat paging/lease behavior and tmux API. Its platform status collector stays at six columns with no Cost cell; the existing no-cost regression remains. No usage storage or permission policy changes.

## Validation

- Five command, guest, palette, status and sysinfo suites: 119 passed. This includes mounted Close/Escape focus restoration with retained filter and a single command request.
- Three shared stylesheet suites: 46 passed.
- Source and test type checks: exit 0.
- Real-app headless scratch fixture: eight report requests at desktop/phone, EN/light and zh-TW/dark, using 60 synthetic instances and 20 rooms. Every status report has 80 rows and six columns; sysinfo has 13 rows. All requests return 200, with no page/report horizontal overflow. Filter, expanded reports and phone end-of-scroll checks pass.
- Independently opened desktop EN status, desktop EN expanded sysinfo end, phone zh-TW expanded status and phone zh-TW sysinfo end originals: readable, Cost absent, no concrete defect, only synthetic values. Other views have automated checks.

The prior main evidence remains historical proof of the fail-first tests and approved visual decision. This folder records the actual alpha integration. No live provider, account, CLI, Fleet launch or Windows campaign was used. Scratch timings are not a performance benchmark. Rollback is a normal revert of the twin; no migration or stored-data change.

## Exact CI correction

Run 44696077392, failed job 136154139297, exposed two alpha-only contracts omitted from the initial focused set: the report phone CSS must include the existing short/coarse landscape branch, and browser waitForFunction calls must receive functions rather than strings (to avoid repeat eval under CSP). The one query and two waits are corrected. All 51 guard/style tests across five files pass. Desktop and portrait declarations are unchanged; the report now follows the application's existing landscape classification. No production collector/authz, strings, component, capture or focus logic changed. The main harness has the same two waits and gets a test-only follow-up.
