# Host CLI install confirmation (M-2793)

The real Settings shell, HTTP handler, held-change store, and authenticator verifier run on an owned loopback listener with scratch HOME. Only the Accounts inventory and installer boundary are synthetic. No fleet start, vendor installer, real account, or native machine is exercised.

- Before: `1be11da9186914756d12fb021e8d8822cc70ab86`, 4 cases; an enforcing remote admin starts the synthetic installer without a code.
- After: 4 current + 4 cached-shell cases. Before the correct code: zero starts. Wrong code: HTTP 401, visible error, authenticated browser remains usable. Correct code: exactly one synthetic dispatch.
- Chromium 156.0.8078.4; desktop 1366 and phone 390; desktop light and phone dark, EN and zh-TW.
- Cached shell: alpha.10 `app.js`, `app-shell.js`, `app-i18n.js`, `app.css`; current feature modules, authentication bridge and feature stylesheet. This is not an all-modules-old test.
- Current and cached phone confirmation inputs/buttons measure at least 44px; no horizontal overflow. The expected wrong-code 401 is the only allowed console error. External browser requests are blocked.
- Captures were taken from the uncommitted working tree on the recorded base: `after-results.json` includes SHA-256 hashes of every changed production file. `SHA256SUMS` covers all 28 original PNGs.

## Gallery

| Surface | Before | Code required | Wrong code | Applied | Cached shell |
| --- | --- | --- | --- | --- | --- |
| Desktop EN | [PNG](before-desk-light-en-immediate.png) | [PNG](after-desk-light-en-code.png) | [PNG](after-desk-light-en-wrong.png) | [PNG](after-desk-light-en-applied.png) | [PNG](skew-desk-light-en-code.png) |
| Desktop zh-TW | [PNG](before-desk-light-zh-TW-immediate.png) | [PNG](after-desk-light-zh-TW-code.png) | [PNG](after-desk-light-zh-TW-wrong.png) | [PNG](after-desk-light-zh-TW-applied.png) | [PNG](skew-desk-light-zh-TW-code.png) |
| Phone EN | [PNG](before-phone-dark-en-immediate.png) | [PNG](after-phone-dark-en-code.png) | [PNG](after-phone-dark-en-wrong.png) | [PNG](after-phone-dark-en-applied.png) | [PNG](skew-phone-dark-en-code.png) |
| Phone zh-TW | [PNG](before-phone-dark-zh-TW-immediate.png) | [PNG](after-phone-dark-zh-TW-code.png) | [PNG](after-phone-dark-zh-TW-wrong.png) | [PNG](after-phone-dark-zh-TW-applied.png) | [PNG](skew-phone-dark-zh-TW-code.png) |

All 24 refreshed after PNGs were visually inspected. The current cards and code/error/success text fit. In the cached English phone captures the Settings breadcrumb is partly behind the fixed top bar, while the confirmation is fully visible. The held alpha.10 shell retains its older “web-verified / General is told” wording and duplicated summary bullet; reload uses current wording. These are inherited presentation limitations, not proof of authority or notification delivery.

## Reproduce

Run `scripts/manual/smoke/smoke-host-cli-enforcement-m2793.mts` with `REPO`, `OUT`, `PW_DIR`, `CHROME`, and an owned CJK `FONTCONFIG_FILE`. Use `BEFORE=1` with a detached owned checkout of the before base, and a distinct `HP` port. The shared smoke fixture tears down its owned listeners, browser contexts and scratch state in `finally`.

Chat per-admin identity separation, lenient policy, public refusal, digest/replay/revocation and actual installer dispatch fences are covered separately in the HTTP/FleetManager/tmux tests with inert process boundaries. The browser uses the web-only host operator's remote enforcing session; it is not a separate chat-admin enrollment or real installer claim.
