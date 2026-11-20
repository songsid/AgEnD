# Fleet Authorizations: house-guide correction (M-3409)

The [rule-by-rule audit](style-guide-audit.md) follows both versions of `docs/design/ui-style-guide.md`. The guide overrides the earlier mockup. The correction follows Fleet Usage/Cache toolbars and plain shared cards.

Fixed: shared `.card` frames, `.tag` status/verb labels, straight `.lbar` state accents, shared toolbar/select/lead classes, token-based spacing/type, readable atomic names/time phrases, phone targets/input sizes, and the empty-state history action. No custom scrollbar, extra danger border or empty-icon size remains. The approval explanation appears before its controls.

Agent sources, targets, hops and selector options use `labelOf()`. People always use their server-provided `label || userId`; they are never resolved through the agent roster. A matching-person/agent-ID regression fails the reviewed version and passes this correction.

## Same requested views, before and after

These baseline screenshots were regenerated from alpha base `232f0fc2` with the same plain synthetic roster and ticket data. None are the user's private originals.

| State | Before | Corrected |
|---|---|---|
| Desktop, sidebar open | [Before](before/desktop-zh-sidebar-open.png) | [After](screens/desktop-zh-sidebar-open.png) |
| Sidebar collapsed | [Before](before/desktop-zh-sidebar-collapsed.png) | [After](screens/desktop-zh-sidebar-collapsed.png) |
| Large text | [Before](before/desktop-zh-large.png) | [After](screens/desktop-zh-large.png) |
| Phone, pending card | [Before](before/phone-zh.png) | [After](screens/phone-zh.png) |
| Phone, decided card | [Before](before/phone-zh-decided.png) | [After](screens/phone-zh-decided.png) |
| Phone, empty state | [Before](before/phone-zh-empty.png) | [After](screens/phone-zh-empty.png) |

Additional English/light and stress views: [desktop EN](screens/desktop-en-sidebar-open.png), [phone EN](screens/phone-en.png), [desktop empty](screens/desktop-zh-empty.png), [1024px](screens/desktop-en-medium.png), [900px](screens/desktop-zh-narrow.png), [long phone names](screens/phone-zh-long.png), [long decided footer](screens/phone-zh-long-decided.png).

The real application uses the shared smoke fixture with a synthetic four-agent roster and stubbed contact API. Chromium is headless. No real Fleet, provider CLI, account or Windows process is started. Principal and supplemental originals were inspected for layout and privacy. Phone navigation keeps its existing horizontal tab scroller; the page content does not scroll sideways.

## Verification and limits

- Initial full registered UI gate: **27/27 smokes pass** on the initial layout revision. The unrelated pages are unchanged in this correction.
- Corrected authorization gate: **11 cases pass**, including 390/900/1024/1366px, large text, long agent/person labels, opened grant fields, filter-chip clearing, focus outline and empty-state action.
- Guide/identity tests: 9 files, 113 pass. Emoji/sidebar-scrollbar/contact tests: 3 files, 47 pass; contact's 37 overlap, giving 123 distinct tests across these 11 files. Existing pinned assertions are unchanged.
- Earlier shared segmented-control consumers: 234 UI tests pass; changelog validation: 75 pass. Test TypeScript has zero diagnostics.
- Before identity fix: collision regression fails semantically with an agent label printed as a person. Fixed contact file: 37/37 pass.
- `render-checks.json` records final geometry, shared styles, tap/input sizes, display labels, no overflow and page/CSP status. `before-checks.json` records the baseline, whose style failures are expected.

This proves local rendering and fixture interactions, not live authorization dispatch. Decision and permission contracts remain unchanged. Rollback: revert the UI commits; no migration or persistent data change.

**The PR remains draft under the user visual hold until the Leader explicitly lifts it.**
