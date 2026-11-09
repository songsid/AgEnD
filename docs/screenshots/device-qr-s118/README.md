# QR add-device proposal (S-118)

Design pictures, not an implemented authentication flow. [Design note](../../design/device-qr-s118.md).

The capture runs main `170d0a60d` in an isolated scratch FleetManager listener, with its real Settings routes, both desktop navigation columns, sign-in HTML, Preact, tokens and shared Dialog. Only the proposed device card/dialog/state is inserted by the visual capture. The private snapshot package version is `2.3.5-beta.2-s118-design.0`; the page's version text is not replaced. There is no live fleet, real account, public tunnel or device enrollment.

| Picture | State |
|---|---|
| [01 Desktop Settings](01-desktop-overview.zh-TW.png) | Real Settings shell, Access & security selected; proposed devices card and Add action. |
| [02 QR](02-desktop-qr.zh-TW.png) | Short-lived QR, readable host, Cancel and folded device-login-code fallback. |
| [03 Allow phone](03-desktop-allow.zh-TW.png) | Browser/device information and one explicit Allow or Deny on the original computer. |
| [04 Phone waits](04-phone-waiting.zh-TW.png) | Real sign-in shell; the phone is still signed out. Dark theme, 390×844. |
| [05 Phone signed in](05-phone-signed-in.zh-TW.png) | Real Settings phone shell; completion/device-list state is visual-only. No add-device or other-device sign-out action. |
| [06 Expired](06-desktop-expired.zh-TW.png) | Settled expiry and a fresh-QR next step. |
| [07 No reachable entry](07-desktop-no-entry.zh-TW.png) | No localhost QR or automatic public link; return to the entry-point settings. |
| [08 Device login code](08-desktop-code-fallback.zh-TW.png) | Eight-character `ABCD-EFGH` fallback, followed by device inspection and approval. |
| [09 Dark QR](09-desktop-dark-qr.zh-TW.png) | Same shared Dialog in the dark theme. |
| [10 Light phone](10-phone-light-waiting.zh-TW.png) | Same phone wait state in light theme. |

Desktop is 1366×900; phone is 390×844. The QR is generated offline with alpha's existing vendored encoder and contains only `https://agend.team.example/signin#add-device=DESIGN-ONLY-NOT-A-LOGIN`. It has no real request or credential. The final phone picture uses the fixture's normal sign-in to reach the real shell; it is not evidence of QR sign-in, permission enforcement or session isolation.

Capture: `scripts/manual/design/device-qr-s118.mts`. Use a private runtime snapshot with src/, launcher/, package.json and dependencies; `REPO`, `OUT`, `PORT`, `PW_DIR`, `CHROME` and `FONTCONFIG_FILE` follow the existing smoke fixture. `QR_ENCODER` points to the repository's vendored `qrcode.module.js` from alpha (main does not contain it yet). No dependency is fetched from a CDN. All ten page-width checks passed; authentication tests and real QR navigation belong to implementation acceptance after design signoff.
