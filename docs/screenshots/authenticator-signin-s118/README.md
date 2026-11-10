# S-118 refreshed PNG proposal — #3548 contract

Proposal only, awaiting the user's approval. Actual signin.html and dashboard Settings shells, synthetic presentation states/own name. No authored production source, authenticator POST, enrollment, real account, fleet start or tunnel operation. Source contract: alpha d5e2a3c873da04a72de4def25c2e53db2889a381 (#3548). Settings uses a local2.3.5-alpha.10+s118 design build of that archive with generated provenance, not a published release; its source-serving fixture is unchanged core code.

| Language / screen | Name + code | Full 401 hint | 429 wait | Phone reachability | 8-character fallback | Settings own name |
| --- | --- | --- | --- | --- | --- | --- |
| zh-TW / desk-light | [PNG](desk-light-zh-TW-primary.png) | [PNG](desk-light-zh-TW-wrong.png) | [PNG](desk-light-zh-TW-paused.png) | [PNG](desk-light-zh-TW-reach.png) | [PNG](desk-light-zh-TW-fallback.png) | [PNG](desk-light-zh-TW-settings-name.png) |
| zh-TW / phone-dark | [PNG](phone-dark-zh-TW-primary.png) | [PNG](phone-dark-zh-TW-wrong.png) | [PNG](phone-dark-zh-TW-paused.png) | [PNG](phone-dark-zh-TW-reach.png) | [PNG](phone-dark-zh-TW-fallback.png) | [PNG](phone-dark-zh-TW-settings-name.png) |
| en / desk-light | [PNG](desk-light-en-primary.png) | [PNG](desk-light-en-wrong.png) | [PNG](desk-light-en-paused.png) | [PNG](desk-light-en-reach.png) | [PNG](desk-light-en-fallback.png) | [PNG](desk-light-en-settings-name.png) |
| en / phone-dark | [PNG](phone-dark-en-primary.png) | [PNG](phone-dark-en-wrong.png) | [PNG](phone-dark-en-paused.png) | [PNG](phone-dark-en-reach.png) | [PNG](phone-dark-en-fallback.png) | [PNG](phone-dark-en-settings-name.png) |

All 24 frames pass overflow/top-edge/44px control checks and were visually inspected. Traditional Chinese renders cleanly. Longer English error/help states use ordinary vertical scrolling. Settings frames focus the existing Owner verification card and the proposed own-name row; the English phone frame ends partway through the unchanged lower setup/remove controls.

The sign-in name alice_tg is synthetic. Settings uses a scripted GET /ui/outside response containing only that synthetic own signinName; no admin list. The 429 frame illustrates a five-minute retryAfterMs, not a fixed product limit. No actual 401/429 authentication request was performed for these projected states. These PNGs are not security, functional sign-in, SKEW or release acceptance.

`receipt.json` records browser/base/geometry. `SHA256SUMS` pins each original PNG. Reproduce with `npx tsx scripts/manual/mockup-authenticator-signin-s118.mjs` and owned CHROME/PW_DIR/FONTCONFIG_FILE/SETTINGS_REPO (the local2.3.x build root). Detailed contract/state plan: ../../design/authenticator-signin-s118.md.
