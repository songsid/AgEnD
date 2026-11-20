# Style-guide audit and correction

Both [English](../../design/ui-style-guide.md) and [Traditional Chinese](../../design/ui-style-guide.zh-TW.md) were read against the alpha source. The house guide takes precedence over the earlier mockup. Fleet Usage and Cache are the closest reference pages for the wide column and filter toolbar; their plain `.card` and shared button styles are retained.

## Violations corrected

- **Rules 1–2, shared components and frames:** removed the request-specific border, padding and radius overrides. Request cards use the plain shared `.card`; only list spacing and minimum-width behavior are local.
- **Rule 1, status and label treatments:** replaced bespoke bordered status/origin pills and the verb chip with `.tag`, `.tag.warn` and existing semantic text classes. Agent names remain atomic plain labels, rather than new decorated pills.
- **Rule 3, straight accent:** replaced the curved inset shadow with shared `.lbar` and `--lbar-color`. Focus uses the standard focus-token outline, not an ineffective border-color declaration.
- **Rules 1 and 4, controls and tokens:** reused `.us-bar-top`, `.us-group` and `.s-page-lead`; removed custom select geometry, extra rejection border and empty-icon sizing. Removed literal 6px metadata gaps, custom badge padding and the custom message line-height. The rounded `.btn` filter buttons already match Usage/Cache and remain.
- **Rule 7, controls and long values:** phone targets now measure at least 44px in both dimensions, including the short All button and person-filter clear control. Selects retain the shared 16px phone input minimum; opened grant inputs are clamped to the root text minimum and wrap. Long names and whole time phrases ellipsize within the card, retaining full text in the DOM and tooltips.
- **Existing CSS pins:** removed a redundant explicit `font-family: inherit` from `.seg-item`; the shared button reset already inherits the token stack, including emoji fallback. Removed the request-specific scrollbar override so it follows existing content-scroll behavior. The emoji and sidebar-scrollbar assertions remain unchanged.

The approval explanation is restored above the controls. A separate identity correction keeps people on the server-provided `label || userId`; agent-roster display names are used only for agent sources, targets, hops and selector options. A collision regression fails the reviewed version and passes the correction.

## Rule-by-rule result

| Guide rule | Result / evidence |
|---|---|
| 1. Shared components | Shared `.card`, `.tag`, `.btn`, `.chip`, toolbar/group classes, `Skeleton`, `Empty`, `ErrorState`. The existing Fleet `PanelHeader` owns the title; the body uses the shared lead class without a duplicate heading. |
| 2. Card frame | No local request-card border/padding/radius. Same plain card frame as Fleet Cache; Settings-only frame comparison is not extended globally. |
| 3. Straight left bar | Pending/focused cards use `.lbar`; the browser checks its 3px, square-ended pseudo-element. |
| 4. Tokens / themes | Type and line-height pairs, spacing, radii and semantic colors use shared tokens. No new literal color/font stack or custom status geometry. Light/dark and large text are captured. |
| 5. CSP | Class-based markup only; no inline style or constructed stylesheet. Browser page/CSP checks and CSP tests pass. |
| 6. States | Initial read uses card-shaped `Skeleton`; stream/visibility refresh keeps content. `Empty` has a hint/history action. Failed initial reads use `ErrorState` with Retry; explicit permission refusal remains an explanatory line. |
| 7. Phone / widths / density | 390, 900, 1024 and 1366px views; long agent and person labels; opened grant fields; phone controls and filter clearing. No horizontal overflow. Shared frame padding and one gap system prevent doubled spacing. |
| 8. EN / zh-TW | Visible copy remains in paired string tables; i18n literal/parity test passes. |
| 9. Same surface / clicks | Existing decisions and filters remain in the web page. No new approval step, host command or second surface. |
| 10. Plain errors | Existing translated unavailable/failed/forbidden text and Retry behavior preserved; no server codes exposed. |
| 11. Product terms | Agent, Fleet and Hub remain English in zh-TW; terminology test passes. |
| 12. Shared icons | `Empty` retains the shared key icon and default size. No emoji used as a control icon. |
| 13. Hub shell | Not changed: this is the Fleet dashboard. Sidebar, header, page routing and Hub shell classes remain untouched. |

## Proof scope

The full registered UI gate passed 27/27 on the first layout revision. The correction changes only this page's local styling/markup plus removal of the redundant segmented-control font declaration; the updated registered authorization smoke is rerun on the corrected source. Eleven guide/identity/CSS-pin files cover 123 distinct tests (the 37 contact tests occur in both focused batches). No assertions are weakened.

Before screenshots are regenerated from alpha base `232f0fc2` using the same plain synthetic roster and DTOs; none are the user's private originals. The revised captures and measurements are under this evidence directory. The user visual hold remains in force.
