# Review follow-up on #3552 (Prism P2-1…P2-4): source-bound captures

- **Captured at head `188b2de5fc51cba25bc9df024fab890c81944a42`** (the PR's source; this directory is the only thing added after it — no `src/` or `tests/` change). Built with `npm run build` from a clean tree; the page footer of the "after" runs reads `Source build · 188b2de5f`.
- **before** = `7198c63dd` (the alpha tip after #3539), built the same way. **after** = the head above. Two real throwaway AgEnDs (isolated HOME, `AGEND_WSL=0`), fake CLIs on PATH (`agy` 1.5.3, `grok` 1.0.70, `opencode` 1.18.34, `claude` 2.1.319).
- **Real Chromium** (Playwright headless shell 1248); desktop 1180 wide, phone 390 wide (full shell); English and zh-TW.
- **Dark is real dark.** The page's theme is the host's saved preference, so it is chosen through the page's own `AgendTheme.set`; each shot's computed `body` background is recorded in `receipts.json` (`painted.bg`: `rgb(33, 33, 33)` for dark, `rgb(255, 255, 255)` for light) and the script refuses to save a "dark" shot that painted white. **No two PNGs here are byte-identical** (`sha256` per file in `receipts.json`).
- **Antigravity is in every host shot**: each is the Antigravity card itself (version line + its button), not a clip of the list that stops at Claude/Codex.
- **Runtime pages are synthetic data** (the page's two reads are answered by the script with one paired Windows computer: Claude Code 2.1.319, Codex 0.167.0, Antigravity 1.3.5, OpenCode 1.18.34); the page code is the build's own. No Windows computer and no vendor was involved; `agy` is a fake CLI.
- **Served-file hashes** (what the browser actually received, sha256 of the bytes of `/ui/js/*` and `/assets/*`) are in `receipts.json` under `variants`. For the "after" variant they equal `sha256sum src/ui/...` at `188b2de5f`:
  `host-install.js 18a6da06…`, `runtime-cli-install.js 91e78717…`, `accounts-view.js c80c3a14…`, `runtime-install.css b0990ff3…`, `app.css 1ca99ab5…`.
- Reproduce: `capture/setup.sh`, `capture/start.sh`, `capture/capture.mjs <out> <matrix|flow|skew|measure>` (paths inside are this machine's; the logic is what matters).

## P2-4 matrix — host (Antigravity card) and Runtime page, before / after

| Page | Device | Theme | Lang | before (`7198c63dd`) | after (`188b2de5f`) |
| --- | --- | --- | --- | --- | --- |
| host | desk | light | en | [png](before-host-antigravity-desk-light-en.png) | [png](after-host-antigravity-desk-light-en.png) |
| host | desk | light | zh-TW | [png](before-host-antigravity-desk-light-zh-TW.png) | [png](after-host-antigravity-desk-light-zh-TW.png) |
| host | desk | dark | en | [png](before-host-antigravity-desk-dark-en.png) | [png](after-host-antigravity-desk-dark-en.png) |
| host | desk | dark | zh-TW | [png](before-host-antigravity-desk-dark-zh-TW.png) | [png](after-host-antigravity-desk-dark-zh-TW.png) |
| host | phone | light | en | [png](before-host-antigravity-phone-light-en.png) | [png](after-host-antigravity-phone-light-en.png) |
| host | phone | light | zh-TW | [png](before-host-antigravity-phone-light-zh-TW.png) | [png](after-host-antigravity-phone-light-zh-TW.png) |
| host | phone | dark | en | [png](before-host-antigravity-phone-dark-en.png) | [png](after-host-antigravity-phone-dark-en.png) |
| host | phone | dark | zh-TW | [png](before-host-antigravity-phone-dark-zh-TW.png) | [png](after-host-antigravity-phone-dark-zh-TW.png) |
| runtime | desk | light | en | [png](before-runtime-desk-light-en.png) | [png](after-runtime-desk-light-en.png) |
| runtime | desk | light | zh-TW | [png](before-runtime-desk-light-zh-TW.png) | [png](after-runtime-desk-light-zh-TW.png) |
| runtime | desk | dark | en | [png](before-runtime-desk-dark-en.png) | [png](after-runtime-desk-dark-en.png) |
| runtime | desk | dark | zh-TW | [png](before-runtime-desk-dark-zh-TW.png) | [png](after-runtime-desk-dark-zh-TW.png) |
| runtime | phone | light | en | [png](before-runtime-phone-light-en.png) | [png](after-runtime-phone-light-en.png) |
| runtime | phone | light | zh-TW | [png](before-runtime-phone-light-zh-TW.png) | [png](after-runtime-phone-light-zh-TW.png) |
| runtime | phone | dark | en | [png](before-runtime-phone-dark-en.png) | [png](after-runtime-phone-dark-en.png) |
| runtime | phone | dark | zh-TW | [png](before-runtime-phone-dark-zh-TW.png) | [png](after-runtime-phone-dark-zh-TW.png) |

## Current head, the host flow (Antigravity: idle → running → finished) and the Runtime confirmation

The only request the page sent for the update was `POST /ui/host-update {"backend":"antigravity","acceptLatestUnaudited":true}` (`receipts.json` → `notes`).

| Theme | Lang | idle | running | finished | Runtime confirmation |
| --- | --- | --- | --- | --- | --- |
| light | en | [png](after-flow-1-idle-light-en.png) | [png](after-flow-2-running-light-en.png) | [png](after-flow-3-done-light-en.png) | [png](after-flow-4-runtime-confirm-light-en.png) |
| light | zh-TW | [png](after-flow-1-idle-light-zh-TW.png) | [png](after-flow-2-running-light-zh-TW.png) | [png](after-flow-3-done-light-zh-TW.png) | [png](after-flow-4-runtime-confirm-light-zh-TW.png) |
| dark | en | [png](after-flow-1-idle-dark-en.png) | [png](after-flow-2-running-dark-en.png) | [png](after-flow-3-done-dark-en.png) | [png](after-flow-4-runtime-confirm-dark-en.png) |
| dark | zh-TW | [png](after-flow-1-idle-dark-zh-TW.png) | [png](after-flow-2-running-dark-zh-TW.png) | [png](after-flow-3-done-dark-zh-TW.png) | [png](after-flow-4-runtime-confirm-dark-zh-TW.png) |

## P2-1 SKEW receipts — the current server and DTO with the page modules of `7198c63dd` served in their place

The "after" server is the real one; Playwright serves `7198c63dd`'s `host-install.js` (sha256 `71d5cb69…`) / `runtime-cli-install.js` (sha256 `58a2533c…`) in place of the current file (all the other modules are the head's).

| Combination | Lang | retained module's label | after the click |
| --- | --- | --- | --- |
| host: head's `accounts-view.js` + retained `host-install.js` | en | [png](skew-host-1-retained-label-en.png) ("Update to 1.5.3", no "not audited") | [png](skew-host-2-after-click-en.png) (real server: `409 latest_ack_required`; no run, `agy` still 1.5.3) |
| host: head's `accounts-view.js` + retained `host-install.js` | zh-TW | [png](skew-host-1-retained-label-zh-TW.png) ("Update to 1.5.3", no "not audited") | [png](skew-host-2-after-click-zh-TW.png) (real server: `409 latest_ack_required`; no run, `agy` still 1.5.3) |
| Runtime: head's `panel-runtimes.js`/caps/inventory + retained `runtime-cli-install.js` | en | [png](skew-runtime-1-retained-label-en.png) / [png](skew-runtime-2-dialog-en.png) ("Update to 1.5.3", dialog describes the pinned download) | [png](skew-runtime-3-after-click-en.png) (the route's answer is **simulated** — the computer is synthetic — with the same rule `runtime-api.ts` applies: `409`, `code: latest_ack_required`) |
| Runtime: head's `panel-runtimes.js`/caps/inventory + retained `runtime-cli-install.js` | zh-TW | [png](skew-runtime-1-retained-label-zh-TW.png) / [png](skew-runtime-2-dialog-zh-TW.png) ("Update to 1.5.3", dialog describes the pinned download) | [png](skew-runtime-3-after-click-zh-TW.png) (the route's answer is **simulated** — the computer is synthetic — with the same rule `runtime-api.ts` applies: `409`, `code: latest_ack_required`) |

## P2-3 phone measurement (real Chromium, `getBoundingClientRect`, CSS px)

| CSS | viewport | Antigravity Update | OpenCode Update |
| --- | --- | --- | --- |
| pre-fix CSS (runtime-install.css @ d51a038b0) | 390 | 261 × 30 | 120 × 30 |
| pre-fix CSS (runtime-install.css @ d51a038b0) | 500 | 261 × 30 | 120 × 30 |
| pre-fix CSS (runtime-install.css @ d51a038b0) | 600 | 261 × 30 | 120 × 30 |
| current CSS (this head) | 390 | 261 × 44 | 120 × 44 |
| current CSS (this head) | 500 | 261 × 44 | 120 × 44 |
| current CSS (this head) | 600 | 261 × 44 | 120 × 44 |
| retained CSS (this head's runtime-install.css, app.css of 7198c63dd) | 390 | 261 × 44 | 120 × 44 |
| retained CSS (this head's runtime-install.css, app.css of 7198c63dd) | 500 | 261 × 44 | 120 × 44 |
| retained CSS (this head's runtime-install.css, app.css of 7198c63dd) | 600 | 261 × 44 | 120 × 44 |
| host Update button, current CSS (this head) | 390 | 261 × 44 | — |
| host Update button, retained CSS (app.css of 7198c63dd) | 390 | 261 × 44 | — |

"pre-fix CSS" = `runtime-install.css` as at `d51a038b0`; "retained CSS" = this head's `runtime-install.css` with `app.css` of `7198c63dd` served in place of the current one (`app.css` is the same bytes at both commits: the fix is deliberately in the file the panel links itself). Captures: [pre-fix](measure-runtime-prefix-phone.png) (30px buttons) · current = [after-runtime-phone-light-en.png](after-runtime-phone-light-en.png); the retained-CSS render was byte-identical to the current one (same sha256), so it is not stored twice.
