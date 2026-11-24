# M-3592: Administration → Sign-in (real app)

These are captures of the real Hub (HTTPS and SQLite, through the Hub test rig) and its real Administration page from this branch, taken with headless Chromium. The administrator is signed in and on **Manage**.

| What | Captures |
|---|---|
| The card with the defaults: 8 hours, and 1 hour without use, each marked as the default | `desk-zh-TW-light-1-default.png`, `desk-en-dark-1-default.png`, `phone-zh-TW-dark-1-default.png` |
| 2 hours and 30 minutes chosen, before saving | `phone-zh-TW-dark-2-chosen.png` |
| After **Save**: 「已儲存。」 / "Saved." | `desk-zh-TW-light-3-saved.png`, `phone-en-light-3-saved.png` |

Checked against each capture's DOM:

- the title is 「登入時間」 / "Sign-in";
- the selected values are 「8 小時（預設）」/「1 小時（預設）」 and "8 hours (default)" / "1 hour (default)";
- the two notes are present;
- after saving, the status line reads 「已儲存。」 / "Saved.";
- the card is 860 px wide on the desktop and 358 px on the phone.
- on the phone, the two lists and **Save** are each 44 CSS px tall: a full tap target (`min-height: var(--tap)` on narrow screens). They measured about 40 px before. The phone captures were re-taken with this fix.

The server side (bounds, administrator only, revision, audit, what a new limit does to sessions already signed in) is tested in `tests/hub-session-limits-m3592.test.ts`, through the real Hub HTTP server with a fake clock.
