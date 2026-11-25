# The room tab is "Settings": copy names Settings → Permissions (M-3723)

The agent's tab that holds **Permissions** is labelled **Settings** / 「設定」 (`app.details`). Copy that pointed people to a room's "Details → Permissions" / 「詳細資訊 → 權限」 (or 「詳細資料 → 權限」) now says "Settings → Permissions" / 「設定 → 權限」, matching #4450's recovery note.

Changed, as copy only:
- `src/ui/contact-auth-strings.js` `newRoomsRestricted` (EN, zh-TW).
- `src/locale.ts` `needs.contact_suggestions` (EN, zh-TW).
- `docs/concepts.md` and the concepts skill (the `/start` paragraph).
- The unreleased changelog fragments that carried the path: `changes/4228-restricted-suggestions-grouped`, `4437` and `4446`, each in EN and zh-TW.
- `tests/needs-you-contact-suggestions-m3381.test.ts`, which pins the chat text.

`tests/fixtures/skew/contact-auth-strings.base-af7517571.js` is a frozen copy of an older base for a skew test, so it is left as it was.

After the change, the grep finds none of `Details → Permissions` or `詳細(資訊|資料) → 權限` in src, docs, the website content or `changes/` (`docs/evidence` and the CHANGELOG files are excluded).

## Capture

`newRoomsRestricted` is the one changed string on the dashboard. It sits in Settings → Chat → ClassicBot defaults.

The capture is the real dashboard in headless Chromium (the pinned Playwright image) with the smoke fixture: desk light EN and desk dark zh-TW, before and after. `*-report.json` holds the note's text, page errors (none) and CSP violations (none), plus the source each run came from: "before" is `f5799032d` (src tree `4cf1b2db`); "after" is this PR's src tree `2f33d070`. `capture.mts` reproduces it: copy it into `scripts/manual/smoke/`, then run it with `REPO`, `OUT` and `LABEL`.

Not in this card: the web-dashboard guide and other pages still call the whole tab **Details** / 「詳細資訊」 (for example "the Details tab", "Details → Runtime", "Details → Loaded every session"). That is a wider rename, left for its own card.
