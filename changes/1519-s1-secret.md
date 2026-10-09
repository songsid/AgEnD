---
section: Fixed
---
- **Settings wizard S1: adding a second bot of a different platform never replaces the first connection.** `draftQuickstart` now matches an existing connection only when platform type, `bot_token_env`, AND actual bot identity (group_id / guild_id) all agree — same-platform, same-env, same-group still reconciles in-place; cross-platform or different-group always appends a new entry. `defaultTokenEnvName` computes a unique env name and the wizard pre-fills it with a `token_env_is_auto` provenance flag so that manually-typed values (including `_2` suffixes) are preserved on platform toggle. (#1519)
- **Settings secret endpoints: 403 for public-link (gateway) sessions.** Six endpoints that write or verify connection tokens/secrets, plus the quickstart probe endpoint that receives raw bot tokens, now return 403 for gateway (`surface: "gateway"`) sessions. Local dashboard sessions are unaffected. (#1519)
