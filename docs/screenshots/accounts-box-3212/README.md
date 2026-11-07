# Settings → Accounts: a box per account (#3212)

Before and after for the Accounts block of Settings → Agent → AI sign-ins and API keys, in the real dashboard served by a scratch AgEnD fleet (empty `AGEND_HOME`, no agents, no accounts, no network) and headless Chromium. The two responses a fresh fleet cannot give — `GET /ui/accounts` and the agent names of `GET /api/settings/fleet/raw` — are answered inside the browser with the same fixture for both sides, so the pages, CSS and scripts are the product's own. **Fixture data only**: example.com addresses, made-up account and agent names, no real credential or account.

- **Before**: `release/2.3.5-alpha` at `3374d56d`.
- **After**: this PR at `0d2a50c1`, the head before this folder was added (the commit that adds it only adds these files).

Each picture shows the whole Accounts block, before on the left and after on the right. Desktop is 1460 px wide; phone is 390 px wide (drawn at 2×).

| | English | 繁體中文 |
|---|---|---|
| Desktop, light | [compare-desktop-light-en](compare-desktop-light-en.png) | [compare-desktop-light-zh-TW](compare-desktop-light-zh-TW.png) |
| Desktop, dark | [compare-desktop-dark-en](compare-desktop-dark-en.png) | [compare-desktop-dark-zh-TW](compare-desktop-dark-zh-TW.png) |
| Phone, light | [compare-mobile-light-en](compare-mobile-light-en.png) | [compare-mobile-light-zh-TW](compare-mobile-light-zh-TW.png) |
| Phone, dark | [compare-mobile-dark-en](compare-mobile-dark-en.png) | [compare-mobile-dark-zh-TW](compare-mobile-dark-zh-TW.png) |

The fixture has a default sign-in and three named accounts on the host, a paired computer with three accounts (one read-only), and Codex with last-known (stale) numbers.

## Shared pieces the after side uses

`.card`, `.s-row`, `.tag`, `.btn`, `Menu` ("used by"), `InfoTip` (Keep sign-in alive), `CompactMeter` (the 5h and weekly windows) and `s-ui-toggle` (#3331). The two stylesheets hold only `tokens.css` variables, so light and dark follow the page; `tests/accounts-box-layout-3212.test.ts` checks that.
