# M-3592: Administration → Sign-in (real app)

These are captures of the real Hub (HTTPS and SQLite, through the Hub test rig) and its real Administration page from this branch at `faa4e026`, taken with headless Chromium. That commit has the reworded first note: a longer sign-in time applies to new sign-ins only, and the time without use applies to everyone at once. The two desktop default shots (`desk-zh-TW-light-1-default.png`, `desk-en-dark-1-default.png`) were re-taken at `58244316`, where the note quotes its fields: 「登入多久後要重新登入」 … 「多久沒使用 Hub 就登出」, and "The without-use limit". The other four keep the earlier wording of that one line. The administrator is signed in and on **Manage**.

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
