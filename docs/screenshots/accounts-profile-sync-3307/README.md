# #3307 profile sign-in sync

Real current Settings shell, production HTTP/session gates, WebBackendLogins and the same LoginController used by chat `/login`. Account rows, auth probes and terminal execution are synthetic/inert. No real CLI, provider/account sign-in, tmux, install or credential-write proof.

Twelve PNGs show desktop EN and phone zh-TW confirmation/running states for Codex/Kiro `work`, plus old-shell confirmations. The SKEW leg serves alpha.10 cached shared assets, backend-signin.js and cli-caps.js against the synchronized server. The new generated cli-caps.js remains byte-identical to current alpha. Chinese was rerendered with Noto Sans CJK TC; initial missing-font captures were replaced.

`receipt.json` records the four passing cases, eight profile-scoped synthetic probes/recoveries and every PNG hash. The source checkout uses its package-version placeholder; these are not screenshots of a published release. The original user’s live-use report and the 2026-11-09 waiver of a separate live Codex relocated-home run are recorded separately in the PR; these images do not replace or extend that evidence.

Reproduce with `scripts/manual/smoke/smoke-accounts-profile-sync-3307.mts`, an owned playwright-core installation/Chromium and a CJK-capable FONTCONFIG_FILE. Use a 3G memory-capped scope. The script creates only owned scratch and starts no fleet or backend CLI. Its fixed-name CLI/tmux guards refuse accidental native execution.
