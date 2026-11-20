# Sidebar chat actions

**Current user-requested Favorite/Split additions:** [fresh desktop/phone captures and proof](favorites/README.md). The original 16 menu images below are historical references from before those sidebar additions.

A sidebar Agent row opens its chat actions on right-click, long-press, Shift+F10 or the context-menu key, without changing the current chat. The header and sidebar share `chatAgentMenuItems`, `Menu` and the phone `AgentSheet`; dialogs and server routes are reused. The existing favorites/workspace row button remains separate. Public/guest viewers gain no chat controls. No stylesheet or permission route changed.

## Real-app originals

Isolated scratch FleetManager, production web UI/cookie/HTTP/SSE, three synthetic agents. Chromium headless only; desktop 1366 × 900 and touch-emulated phone 390 × 844. No substituted UI/markup and no vendor CLI, live account, real Fleet launch or lifecycle operation. Right-click uses the mouse; long-press uses Chromium's touch input. The unchanged header is the visual reference, and the new sidebar menu is the after view. The user's private screenshots are not published. Browser-native link menus are outside the page screenshot surface.

| Size / appearance | Header reference | Sidebar after |
|---|---|---|
| Desktop light EN | [PNG](desk-light-en-header.png) | [PNG](desk-light-en-sidebar.png) |
| Desktop light zh-TW | [PNG](desk-light-zh-TW-header.png) | [PNG](desk-light-zh-TW-sidebar.png) |
| Desktop dark EN | [PNG](desk-dark-en-header.png) | [PNG](desk-dark-en-sidebar.png) |
| Desktop dark zh-TW | [PNG](desk-dark-zh-TW-header.png) | [PNG](desk-dark-zh-TW-sidebar.png) |
| Phone light EN | [PNG](phone-light-en-header.png) | [PNG](phone-light-en-sidebar.png) |
| Phone light zh-TW | [PNG](phone-light-zh-TW-header.png) | [PNG](phone-light-zh-TW-sidebar.png) |
| Phone dark EN | [PNG](phone-dark-en-header.png) | [PNG](phone-dark-en-sidebar.png) |
| Phone dark zh-TW | [PNG](phone-dark-zh-TW-header.png) | [PNG](phone-dark-zh-TW-sidebar.png) |

All 16 originals were inspected; the four final phone sidebar images were re-inspected after adding the visible target name. That phone-only addition preserves the desktop views. The phone's verification footer can fall below the captured body viewport; these static images do not prove its scroll reachability. Dialog bodies retain their existing scrolling. A later elapsed-clock correction changes no rendered markup/styles.

[checks.json](checks.json) records all eight cases: matching ordinary agents offered equal header/sidebar action rows; URL unchanged on context open; Escape returned focus to the row; desktop Shift+F10 and outside dismissal passed; no page errors, CSP violations, document overflow, clipped menu/dialog bounds or unexpected write requests. A single target-scoped activity read supplies optional controls without mounting a ChatPanel/history. This is synthetic browser/DOM proof, not physical iPhone/Safari coverage.

## Tests and controls

- Base behavior: the initial six interaction cases had four assertion failures and two permission positives. Right-click/keyboard/touch did not open the application menu.
- `npx vitest run tests/sidebar-context-menu-m3485.test.ts tests/web-chat-menus-2959.test.ts tests/web-instance-nav-n1.test.ts tests/web-chat-workspace-sidebar-3637.test.ts tests/web-pins-ui-m3271.test.ts tests/unified-runtime-ui.test.ts tests/web-app-modules-1408.test.ts tests/web-guest-sidebar-prefs-m3280.test.ts`: **119/119**.
- Phone target-heading delta: sidebar context + pins **21/21**; phone agent-pages/meta-line contracts **14/14**. These overlap the main set where applicable.
- Final monotonic-clock delta: sidebar context, shared Menu and phone page/meta contracts **38/38**.
- `npx tsc --noEmit -p tsconfig.test.json`: exit 0. `node --check` passed for changed UI modules; `git diff --check` clean; changelog fragment check passed.
- Four compiling controls each turned assertions red: ignoring touch movement (1), removing guest/read-only admission (3), substituting the current chat for the selected target (7), and removing modal Escape priority (1). Sources were restored after every run; [results](mutations.json).

The browser exercise caught and corrected a duplicate import rejected by Chromium, target activity-state asymmetry, and drawer-before-dialog Escape handling. Capture-only locator and test-fixture mistakes were corrected before final evidence; no failed run is presented as a pass. No destructive action was clicked in the browser.

Review follows `docs/design/ui-style-guide.md` and its zh-TW copy: existing shared components/tokens, no custom CSS, visible target on touch, scoped native-menu suppression, permission fallback for retained modules. Rollback reverts these UI/gesture and skill changes; no data, configuration or server authorization migration is involved. The PR stays draft under the user's visual hold until explicitly released.

## Review correction

See [R1 target-card and command-dismissal proof](r1/README.md), including the new Beta-card original. Original menu images carry; the main menu layout and styles did not change.
