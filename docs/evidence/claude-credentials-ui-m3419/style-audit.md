# UI style-guide audit

Checked against both EN and zh-TW guides on the development branch. The approved real-app captures use generated fixture data, not a drawn HTML mockup.

| Rule | Check |
|---|---|
| 1 Shared components | Existing Accounts rows, Dialog, confirmDialog, Skeleton, ErrorState, toast and Icon. |
| 2 Card frame | No new Settings card frame; existing Accounts card/row unchanged. |
| 3 Left edge | No new accent edge. |
| 4 Tokens/themes | Spacing, tap size and colours use shared tokens; all light/dark cases captured. |
| 5 CSP | No inline styles or constructed CSS. Browser reports no CSP errors. |
| 6 States | Skeleton during metadata read, retryable ErrorState on failure, fixed localized errors, saved-unverified state. |
| 7 Phone | 390px and desktop1366px; 44px touch targets, password inputs16px; no horizontal overflow. Header/footer fixed, body scrolls with bottom padding. Empty Save disabled, asserted in browser and unit control. |
| 8 EN/zh-TW | Every new visible string registered in both locales. Chinese glyphs and text visually reviewed. |
| 9 Same surface | Accounts and Needs you open the same method chooser. Pasting/saving finishes in the dashboard. Help opens localized docs in a new tab; token acquisition is explained there. Only used-profile changes need an existing shared confirmation: threat is interrupting work or switching a running account without notice. Removal confirms local secret deletion. |
| 10 Errors | Plain local-verification, stale revision, busy profile, input and unavailable-storage recovery; no raw exceptions or credentials. |
| 11 Product terms | Agent/Fleet/General/Hub retained where used in Chinese. |
| 12 Icons | Shared external-link and chevron; expanded caret points down. No emoji icons. |
| 13 Hub shell | No Hub shell changes. Host account controls only; paired-computer flow retained. |

Eight locale/theme/device combinations, 76 after screens, plus eight baseline Accounts screens. The API-key overview and scrolled phone frames show both the initial layout and the complete last note above the footer. Every measurement is in capture-results.json. Source-only changes after capture affect error classification/admission, not the approved layout.
