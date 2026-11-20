# Claude credential help pages — S-203

Four originals captured from the locally built website, with a headless Chromium browser in WSL. Desktop: 1440 × 1000; phone: 390 × 844; light mode. Full-page captures contain documentation only, with no account sign-in or real credential.

- `desktop-en.png`, `phone-en.png`: English help page.
- `desktop-zh-TW.png`, `phone-zh-TW.png`: Traditional Chinese help page.

Local Astro build: 34 pages, success. The host's Node 22.22.2 is below this Astro release's minimum; the build used an isolated current Node 22 runtime. No host runtime or dependency lock was changed.

Browser checks: both final URL paths return HTTP 200, exactly one of each stable anchor (`subscription`, `oauth`, `api`) per page, the documented command present, and no horizontal document overflow at either width. External browser requests were blocked; no Anthropic account or model call was made.

Publication order: the user approved publishing these docs together with beta.16. The coordinator may merge only after npm shows `2.4.0-beta.16`; the website deploys from main.

Release wording check: compared the method names, Get a token for me / 幫我取得 Token, saved-unverified state, replace/remove instructions and organization-managed limitation against the beta.16 source at `2561cb29b1d315c358e55749c3b41d305273139f`. Added the private sign-in option and retained the manual setup-token alternative. Saving is not provider verification. Both pages retain subscription/oauth/api anchors.

The four originals are historical layout evidence from `5f81e0ea`, before the organization-managed limitation and final retrieval wording. They are not screenshots of the final text. This release delta changes documentation only; no provider sign-in, credential or model call was made.
