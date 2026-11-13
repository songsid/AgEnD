# Room-assistant administration UI

Actual Hub shell, vendored Preact/shared cards and production Hub client/component, served by an owned loopback
fixture. Session and assistant APIs are fake. No real account, Hub directory, Fleet or vendor CLI is involved.
The fixture's input values include a long bilingual room name and both working and idle controllers.

`scripts/manual/hub-assistant-admin/browser.mts` runs one Chromium instance through eight desktop/phone ×
light/dark × en/zh-TW cases. `receipt.json` records43 checks, eight completed cases, no browser/server errors,
source SHA256 prefixes and completed browser/listener cleanup. Each case checks no horizontal page overflow,
selected account/cap and CSRF forwarding, stopping only one room, and preserving an unsaved edit after stop or
failed save. The direct card captures show the new content inside the app's own scrolling panel; a full-page
viewport capture alone would miss it.

Each case has three PNGs: `*-settings.png`, `*-now.png`, `*-usage.png`. They use the shared card/form/grid/row/tag,
Skeleton/Empty/ErrorState components and existing Hub room vocabulary; no new CSS or second chat renderer.

Reproduce from this worktree with a matching dependency snapshot and an installed Playwright Chromium:

```
OUT=.artifacts/assistant-admin-browser-cards node node_modules/tsx/dist/cli.mjs scripts/manual/hub-assistant-admin/browser.mts
```

The harness checks load1≤10 before launch and each case. Only one browser is used. The screenshots prove the UI
with the agreed stub, not real backend sign-in, native tool denial, server authorization or live room routing.

The PNGs and receipt bind the first UI commit e078ed6d2. The subsequent review delta changes usage-only
failure isolation, the successful-stop/failed-refresh message, and invalid-limit submission; it adds seven
focused UI cases (17/17 pass). The healthy screenshots remain historical evidence at their bound source,
not a browser rerun of the replacement head.
