# Every in-use Claude sign-in warned before it ends (#3572, M-2825)

Drawn in the real web app on the shared smoke fixture (the product's own web server from an in-process FleetManager, a scratch home, loopback only), with `TZ=Asia/Taipei`. Setup:
- `CLAUDE_CONFIG_DIR` points at a scratch home, never the real `~/.claude`.
- A stub `claude` on `PATH` only prints a version, so Settings lists the CLI.
- Three Claude sign-ins whose `.credentials.json` holds only fake tokens:
  - the default, ending in 20 days;
  - profile `hsinlin`, ending in 9 h;
  - profile `jefflin`, which ended 2 h ago.
- Two agents use `hsinlin` and `jefflin`. Keep-alive is off for all three.

- `*-accounts`: Settings → Agent → AI accounts. Each row's end date, unchanged by this PR (#3292 already reads it from the file); identical before and after.
- `*-needs`: Needs you. **Before** (`release/2.3.5-alpha`): nothing, because keep-alive is off. **After**: "Claude Code · hsinlin: this sign-in ends by 2026-11-11 01:57 …" and "Claude Code · jefflin: this sign-in reached its end date (2026-11-10 14:57) …", each with Sign in. The same lines go into General's live Needs-you message in chat.

Cases: desk light zh-TW, desk dark EN, phone light zh-TW.
