# Dev twin: Fleet task copy (M-3548)

Actual main #4371 merge `152c4f9c1182e464501840944f240d5ced65c09e` (13:12:33Z), fetched main ancestry, all15approved blobs and all five post-merge workflows were verified before this standalone dev twin. Fresh dev parent is `94546a9c55d9ebebea768c1b56f13eea72d2c1bb`, which includes the required #4367 task-detail redesign.

Only the same three zh-TW values change. Reversing those exact values reconstructs both whole dev production files byte-for-byte, preserving #4367 and every other dev behavior. Thirteen non-product paths copy approved main exactly, including tests, original harness and historical main images/evidence. No whole component replacement.

The newer dev detail page renders metadata in `.tp-opened`, with an existing ` · v1` suffix. A bounded dev capture adapter changes that locator and expects all three footer separators to be the same spaced U+00B7. The main harness and its historical capture bindings remain unchanged.

| Case | Navigation | Metadata footer |
|---|---|---|
| Desktop dark zh-TW | [Navigation](desk-dark-zh-TW-nav.png) | [Footer](desk-dark-zh-TW-footer.png) |
| Phone dark zh-TW | [Navigation](phone-dark-zh-TW-nav.png) | [Footer](phone-dark-zh-TW-footer.png) |
| Desktop light English | [Navigation](desk-light-en-nav.png) | [Footer](desk-light-en-footer.png) |

All six fresh originals were individually visually inspected: readable/privacy-clear, no obvious clipping within the captured views. No parent main image was re-inspected.

Fresh dev registered-dictionary tests4/4 PASS, source/test types exit0, changelog768/public/Gitleaks clean. Actual scratch-app labels/footer/overflow/pageerror/CSP checks pass all3cases. Fresh dev captures are justified by the different existing #4367 page; no main browser/images repeated. Six parent-folder images remain historical main proof, not dev captures.

Phone inactive tabs retain existing icon-only presentation; rendered labels are asserted, and desktop shows both. Metadata frames are scrolled views, not proof of every page section, all interactions or native phone behavior. No CSS, action, permission, route, storage, Fleet start or provider/pane changes. [Current dev bindings](verification.json), [actual captured records](capture.json), [historical main evidence](../README.md). Rollback only the three localized values; no migration.
