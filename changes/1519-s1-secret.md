---
section: Fixed
---
- **Settings wizard S1: adding a second platform no longer silently replaces the first connection.** `draftQuickstart` previously matched existing connections by `bot_token_env` and overwrote them. It now always appends a new entry. The wizard UI defaults `token_env` to a platform-specific name (`AGEND_TELEGRAM_TOKEN` / `AGEND_DISCORD_TOKEN`) and updates it when the platform toggle changes, so each connection naturally gets a distinct env variable. (#1519)
- **Settings secret endpoints: 403 for public-link (gateway) sessions.** Six endpoints that write or verify connection tokens/secrets now return 403 with a clear message when called from a public-link session (`surface: "gateway"`). Local dashboard sessions are unaffected. (#1519)
