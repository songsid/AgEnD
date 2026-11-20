# Style guide audit

Checked against `docs/design/ui-style-guide.md`, including its newer rule 14, in English and Traditional Chinese.

| Rule | Check |
| --- | --- |
| 1 Shared components | Existing credential Dialog, shared buttons, fields, confirmation and status roles. |
| 2 One Settings frame | Optional flow sits in the same account sheet; no new card frame. |
| 3 Left edge | No additional coloured edge. |
| 4 Tokens/themes | Existing tokens and both themes; new phone buttons use `var(--tap)`. |
| 5 Inline styles | None. |
| 6 States | Waiting, owned cancel, saved, timeout, revoked and failed/uncertain save have explicit states. |
| 7 Phone | No horizontal overflow; active controls at least 44px; scoped body scroll, fixed actions and paired scrolled captures. |
| 8 Languages | Every new string registered in EN/zh-TW, including recovery instructions. |
| 9 Same task | Start and return in the same account sheet; paste remains available. |
| 10 Errors | Plain recovery, 10-minute expiry, verify again and cleanup operator advice; no native/raw error. |
| 11 Terminology | Agent remains English in Chinese copy. |
| 12 Icons | Existing shared help link; no new emoji or custom icon. |
| 13 Hub shell | No Hub/shell change. |
| 14 Info details | No info icon. Required private-flow and recovery text remains visible. |

Layout assertions pass for all 36 captures. Static image review confirmed CJK rendering, no token value and full Cancel visibility; the paste fallback pair shows the input fully above the footer.
