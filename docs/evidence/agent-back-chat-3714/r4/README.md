# R4: one phone Settings heading

The owner’s phone-only correction merges **← Settings / Basic info / Back to chat X** into one scrolling content row. There is one visible section title; its existing scope/lead are hidden only in the narrow layout. The category index has its own **Settings + X** row. Both links retain 44px targets and the localized Back to chat / 回到聊天 tooltip and accessible name. Desktop composition, pane-header close, navigation and authority are unchanged.

This reuses `AgentPageHead`/`PageHead`, `.s-row`, `.s-back`, `.icon-btn`, shared `Icon` and existing localized labels. No new shared export or import contract is introduced. The hidden desktop back link moves inside the heading grid; phone-only rules arrange three columns. The duplicated section label is removed.

## Current phone gallery

| Surface | zh-TW light | zh-TW dark | EN light | EN dark |
|---|---|---|---|---|
| Section | [PNG](browser/phone-light-zh-TW/light-zh-TW-settings.png) | [PNG](browser/phone-dark-zh-TW/dark-zh-TW-settings.png) | [PNG](browser/phone-light-en/light-en-settings.png) | [PNG](browser/phone-dark-en/dark-en-settings.png) |
| Category index | [PNG](browser/phone-light-zh-TW/light-zh-TW-settings-index.png) | [PNG](browser/phone-dark-zh-TW/dark-zh-TW-settings-index.png) | [PNG](browser/phone-light-en/light-en-settings-index.png) | [PNG](browser/phone-dark-en/dark-en-settings-index.png) |

[Desktop light control](browser/desktop-light-zh-TW/light-zh-TW-settings.png) · [desktop dark control](browser/desktop-dark-zh-TW/dark-zh-TW-settings.png). The approved EN desktop gallery remains in historical R3. R3’s eight phone originals are BEFORE evidence for this revision; their receipts and files are unchanged.

## Evidence

Clean capture source: `1629f5c5808c75c488ca6e9194c17b3552239dd3`. The initial index-grid specificity diagnostic is excluded. All seven final browser receipts bind their Git tree, inputs, harness and served assets to this committed source.

- [Fail-first](offline/fail-first.log): two assertion failures /19 controls against R3, covering the shared heading and missing index title. [Exact test snapshot](offline/fail-first.test.txt); the final test additionally exercises a blocked unfocused-pane return.
- [Final focused checks](offline/focused.log):90/90 across five files with one worker; [native source](offline/source-types.log) and [test typecheck](offline/test-types.log) pass. [Three selected reversals](offline/mutations/receipt.json) compile, fail assertions and restore byte-exact: separate back row, duplicated section label, missing index title. The previously disclosed global-router fallback remains an exploration survivor; no claim it is caught.
- [Browser verification](browser-verification.json):7 serial Chromium runs /65 checkpoints /22 PNGs,133 Git inputs,1,425 served bindings and one exact retained-CSS substitution. Four current phone variants assert one visible h2, equal vertical centers for back/title/X,44px targets and no overflow. Actual Enter/re-click, Cancel/discard, scrolling, own-pane return/peer draft and header-close controls remain in the journeys; one SSE, zero browser errors/external requests/settings writes.
- Four current desktop single/split comparisons retain the same return geometry. Full-image differences are7–43 pixels; these are not claimed pixel-identical. [Image inspection](visual-review.md) finds no desktop layout change or phone blocker.

The retained-CSS phone case uses exact R2 `app.css` on the current fixture server; the newer row may keep older spacing/typography, but links remain usable and44px, without errors. Earlier R3 retained-module controls remain historical; there is no new import/export and no new old-backend/full-release/popup/native claim.

Owned scratch cookie/HTTP/SSE/UI with fixture status/names only. No Apply, message send, account, CLI, AD, pilot or live-Fleet operation. R3 source/security/desktop scope carries except these two UI files and test/harness/evidence delta. Rollback is a UI revert; no migration.

HOLD remains: parent #3732 owner OK + merge first; then plain merge-sync, fresh Fable/exact-head CI. This phone gallery also needs owner OK. Coordinator owns merge.
