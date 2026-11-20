# UI style-guide audit

Checked against `docs/design/ui-style-guide.md` on the development base, including all zh-TW copy.

| Rule | Check |
|---|---|
| 1 Shared components | Existing Accounts Row, status tag, metadata bar and note; no new component style. |
| 2 Card frame | Existing s-account-row/card frame unchanged. |
| 3 Left edge | Existing account status styling only; no new accent. |
| 4 Theme tokens | Existing usable/not_signed_in/unknown classes in light and dark. |
| 5 Inline styles | None added. |
| 6 Loading/empty/error | Existing Accounts loading/error controls retained; unknown request has an explicit note. |
| 7 Phone/desktop | Eight cases, no horizontal overflow; phone controls at least 44px. |
| 8 EN/zh-TW | All new strings registered in both languages; timestamp uses the selected locale. |
| 9 Finish in place | Status appears on the current Accounts row; existing Replace action remains beside it. |
| 10 Plain errors | 401/403 gives replacement action; network unknown explicitly does not mean invalid. |
| 11 Agent/Fleet | Existing English product vocabulary preserved; no new conflicting wording. |
| 12 Shared icons | No new icons or emoji. |
| 13 Hub shell | No Hub shell changes. |
| 14 InfoTip | No info icon added; the state and recovery note remain directly visible. |

The saved credential input/dialog, its help links and lifecycle confirmations are unchanged. A timestamp is observation metadata, not a claim that the credential will always remain valid.
