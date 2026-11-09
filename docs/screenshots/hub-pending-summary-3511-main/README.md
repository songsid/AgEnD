# #3511 main twin — shared confirmation display

The shared `PendingChanges` card translates only the exact existing EN/zh-TW Hub connection sentence in the page's language, preserving the server-supplied target. Unknown/extended lines remain verbatim. Stored proposal/id/digest/authority and controls are unchanged. Its own dictionary avoids a dependency on newer i18n data. The existing `register` export is reused; no new module import is introduced.

This is the shared-component twin of the alpha M-2779 fix. Main has no company-join backend or Hub Run control; those alpha-specific routes, locale keys and Stop wording are absent here. No such feature or action is enabled by this PR.

- Earlier main renderer: 2 of 5 semantic locale cases fail. Candidate: **155/155** across seven focused/changelog files, both type checks pass.
- Four independent guard reversals fail collected assertions (localization, exact target, unknown-line fallback, and forbidden network copy outside the exact two-sentence scanner allowance). All originals restored.
- **8 PNGs / 17 checks** show before/after on desktop/phone, EN/zh, in the real main **Settings → Advanced** shell. These are explicitly display-only fixtures: a synthetic client-store row labeled “Display fixture”, no backend proposal or company-join authority/action. No API replies are stubbed. Image review confirms full target/scope and no new clipping/overflow/blank frame.
- Actual alpha pending Start/withdraw, waiting popup, Stop/Run and retained-module/earlier-server evidence is in the alpha counterpart's `docs/screenshots/hub-p3s-m2779/`. It is not a main Hub backend claim.

Reproduce with owned `REPO`, `PW_DIR`, `CHROME`, CJK `FONTCONFIG_FILE`, and `OUT`:

```sh
npm test -- tests/web-pending-hub-summary-3511.test.ts tests/named-link-test-2906.test.ts tests/i18n-ui-literals-2390.test.ts tests/settings-control-ui-1423.test.ts tests/web-confirm-1408.test.ts tests/ui-css-literals-ratchet.test.ts tests/changelog-fragments.test.ts
npm run typecheck
npm run typecheck:tests
MATRIX=desk-light-en,phone-dark-en,desk-light-zh-TW,phone-dark-zh-TW node --import tsx scripts/manual/hub-p3s-m2779/main.mts
MAIN=1 node scripts/manual/hub-p3s-m2779/verify.mjs
```

Run reversals alone while no other job reads the modified files; originals are restored in `finally`. Before images retain the exact old `e5bef1cb` shell in separate contexts. No schema or persisted state changes; rollback is a UI revert. The digest-first manifest excludes itself.
