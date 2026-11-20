# Fleet Authorizations layout (M-3409)

The page used the narrow chat column and full-width navigation segments for filters. Its button segments inherited browser borders, card metadata inherited body size, and message padding was invisible against an identical card background.

The update follows the approved layout review:

1. Standard primary/quiet filter buttons and a shared segmented-button reset.
2. The same wide column as other Fleet overview pages.
3. A compact wrapping filter row, inline agent selector and removable person chip.
4. Title, route, message and footer typography at distinct token sizes.
5. A recessed, bordered message surface with a thin scrollbar.
6. Roster display names via `labelOf()`, atomic name chips and timestamp phrases; full instance ids remain available on hover. Supplied actor labels take precedence over roster fallback.
7. One spacing system, pending accent and a focus border with an actual border style.
8. Lead text valid for history and pending requests; an empty-state hint and View all records action.

Decision, permission, filtering and transport contracts are unchanged.

## Rendered views

The real application runs from the shared smoke fixture with a plain synthetic four-agent roster and stubbed contact-ticket API. Chromium is headless; no real Fleet, provider CLI, account or Windows process is started.

- [Desktop EN, sidebar open](screens/desktop-en-sidebar-open.png)
- [Desktop zh-TW, sidebar open](screens/desktop-zh-sidebar-open.png)
- [Desktop zh-TW, sidebar collapsed](screens/desktop-zh-sidebar-collapsed.png)
- [Desktop zh-TW, large text](screens/desktop-zh-large.png)
- [Phone zh-TW](screens/phone-zh.png)
- [Phone EN](screens/phone-en.png)
- [Phone zh-TW, decided card](screens/phone-zh-decided.png)
- [Phone EN, decided card](screens/phone-en-decided.png)
- [Desktop empty state](screens/desktop-zh-empty.png)
- [Phone empty state](screens/phone-zh-empty.png)

Every populated view includes pending and decided tickets; the phone viewport can require vertical scrolling for the lower card, so two extra captures show it after scrolling. All eight principal originals were visually inspected. The phone Fleet navigation retains its existing horizontal tab scroller. No private names or chat-shaped ids appear.

`render-checks.json` records wide-column selection, desktop filter alignment, recessed message contrast, footer hierarchy, phone tap sizes, no horizontal overflow, display labels and no page/CSP errors. The smoke also checks focus borders and the empty-state history action.

## Verification and limits

- Seven focused UI files: 161 tests pass, including contact authorization, shared tabs, Settings highlights, guest shell, header, details and org pages.
- Four additional files: 73 tests pass (Settings regrouping, task-card menu, i18n and UI-gate discovery).
- Final person-filter case: 1 passes; test TypeScript has zero diagnostics.
- Segmented-control inventory: Fleet desktop/phone navigation, global Settings, agent Settings, task-card tabs and the chat/View/Search switch. Inline segments use separate button classes. Existing scoped active styles remain unchanged.
- Full registered UI gate: **27/27 smokes pass**, including the new authorization layout checks.
- Changelog validation: 75 tests pass.

This proves rendering and fixture interactions, not a live authorization dispatch. Rollback: revert the UI/evidence commit; no data migration or permission-policy change.

The PR remains on visual hold until the user approves these views.
