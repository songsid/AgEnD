# Settings → Accounts: the straight left bar (#3407)

This is the user's report on #3367: 「右半部又出現左側圓倒角顏色 設計錯誤」. The Accounts boxes drew each account's state colour as a 4px border-left that curved into the box's rounded corners. The house style (#2330/#2332/#2489) is the straight left bar: the `.lbar` shape, a 3px square line that stops short of the corners.

The pictures come from `scripts/manual/smoke/smoke-accounts-leftbar.mts`. It runs the shared fixture (the product's own web server, a scratch home, no fleet start), and answers `/ui/accounts` in the page with fixture data:
- this computer: signed in, not signed in, and not known;
- a paired computer, **Desk PC**: signed in, and not signed in.

**Fixture data only.** The addresses are on example.com and every account name is made up.

| | Before (release `f61e3608`) | After |
|---|---|---|
| Desktop, light, English | [before](desk-light-en-before.png) | [after](desk-light-en-after.png) |
| Desktop, dark, 繁體中文 | [before](desk-dark-zh-TW-before.png) | [after](desk-dark-zh-TW-after.png) |
| Phone, light, 繁體中文 | [before](phone-light-zh-TW-before.png) | [after](phone-light-zh-TW-after.png) |
| Phone, dark, English | [before](phone-dark-en-before.png) | [after](phone-dark-en-after.png) |

## Mixed versions in an open tab (#3407 review)

`accounts.css` loads separately from the shell and from the Accounts markup, so an open tab can hold an older copy of either half. The fix is in the sheet only; the markup is unchanged. Both mixes still draw exactly one edge per row:
- [Older markup with this sheet](skew-old-markup-desk-light-en.png): the straight bar, in each state's colour.
- [This markup with the older sheet](skew-old-sheet-desk-light-en.png): the older 4px edge, and no second bar.
