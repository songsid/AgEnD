# Settings → Accounts: a named account signs in like the default one (#3212)

Before and after for the account **Sign in** dialog of Settings → Agent → AI sign-ins and API keys → Accounts, in the real dashboard served by a scratch AgEnD fleet (empty `AGEND_HOME`, no agents, no accounts, no network) and headless Chromium. The responses a fresh fleet cannot give — `GET /ui/accounts`, the sign-in endpoints (`/ui/browser-backend-signins`, and `/ui/backend-login` for the older flow) — are answered inside the browser, and the same account list is used for both sides, so the pages, CSS and scripts are the product's own. **Fixture data only**: made-up account name (`CHY`), a sample provider address and code, no real credential, e-mail or account.

- **Before**: `release/2.3.5-alpha` at `78d80b9e`.
- **After**: this PR at `fc6b8f7c`, the head before this folder was added (this folder is the only later change).

Each `compare-*` picture has four rows, two dialogs each: the named account before and after, then the default account before and after. Desktop is a 1280 px window; phone is 390 px wide (drawn at 2×). Dialog crops only.

| | English | 繁體中文 |
|---|---|---|
| Desktop, light | [compare-desktop-light-en](compare-desktop-light-en.png) | [compare-desktop-light-zh-TW](compare-desktop-light-zh-TW.png) |
| Desktop, dark | [compare-desktop-dark-en](compare-desktop-dark-en.png) | [compare-desktop-dark-zh-TW](compare-desktop-dark-zh-TW.png) |
| Phone, light | [compare-mobile-light-en](compare-mobile-light-en.png) | [compare-mobile-light-zh-TW](compare-mobile-light-zh-TW.png) |
| Phone, dark | [compare-mobile-dark-en](compare-mobile-dark-en.png) | [compare-mobile-dark-zh-TW](compare-mobile-dark-zh-TW.png) |

What the pictures show:

- **Named account, before**: Sign in opens the web-terminal flow — "Use a temporary public link", then a terminal page and a one-time access code.
- **Named account, after**: the same dialog as the default account, titled with the account (`Sign in to Claude Code · CHY`): press Sign in, open the provider's page, paste the code.
- **Default account, after**: the title says which account (`· Default sign-in`); the Check sign-ins and Sign in later buttons the first-install page needs are gone; **Use console fallback** is a small link instead of a button beside Close.

`steps-desktop-light-en` and `steps-mobile-dark-zh-TW` follow both accounts through the four steps (press Sign in → the provider's page opens → the code is pasted → signed in): apart from the account name in the title the two are the same.

## Shared pieces the after side uses

`Dialog`, `.btn`, the existing sign-in cards (`mountStructuredSignIns`, with the `ask` / `dashboard` options #3321 S01 and S12 added) and the in-app confirmation. No new class and no new colour: light and dark follow the page. The setup page and the installer's `?backend_signins=` list do not pass the new `dialog` option and look as they did.
