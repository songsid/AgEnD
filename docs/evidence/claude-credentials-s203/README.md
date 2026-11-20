# Claude credential help pages — S-203

Four originals captured from the locally built website, with a headless Chromium browser in WSL. Desktop: 1440 × 1000; phone: 390 × 844; light mode. Full-page captures contain documentation only, with no account sign-in or real credential.

- `desktop-en.png`, `phone-en.png`: English help page.
- `desktop-zh-TW.png`, `phone-zh-TW.png`: Traditional Chinese help page.

Local Astro build: 34 pages, success. The host's Node 22.22.2 is below this Astro release's minimum; the build used an isolated current Node 22 runtime. No host runtime or dependency lock was changed.

Browser checks: both final URL paths return HTTP 200, exactly one of each stable anchor (`subscription`, `oauth`, `api`) per page, the documented command present, and no horizontal document overflow at either width. External browser requests were blocked; no Anthropic account or model call was made.

Publication HOLD: the website deploys from main. This PR must remain draft until M-3419 ships in a beta and the user approves the captures. The pages describe that beta feature and are not a claim that it has shipped.
