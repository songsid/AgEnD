# S-255: install the dashboard and the Hub as an app

Base: release/2.3.5-alpha (b9663fb3e).

**What changed**
- **`/sw.js`** (web-icons.ts `SERVICE_WORKER`) is served before sign-in on the dashboard, the public link and the Hub, with `no-cache`.
  - It has **no fetch handler and opens no cache**. No API answer, chat, file or page is stored or answered by it, so signing out, a revoked session or an updated page behave as before.
  - It is the minimal worker the installed app (and later closed-tab notifications, S-257) needs.
- **`app-install.js`** (shared, started once by app.js on signed-in pages, never a guest's or a reader's) registers it at `/` and keeps the browser's install offer:
  - Chrome/Edge on localhost or a trusted https address: an **Install** button opens the browser's own dialog.
  - Safari on iPhone/iPad: "In Safari, tap Share, then Add to Home Screen."
  - An https address whose certificate the browser doesn't trust (a Hub's self-signed one): Chromium refuses the worker (SecurityError). The page says why and asks for a trusted certificate. **No prompt that fails.**
  - A plain-http LAN address: says to use localhost or https.
  - Already running as the app, or a browser that offers nothing: no hint.
- **Where it shows:**
  - Fleet: Needs you → "This device", under the notification row.
  - Hub: an install button, a screen with an arrow into it, named and titled "Install as an app". It is in the headers of the chats list, Notices and each room, beside the bell. On a phone it shows the short word 安裝 / Install, and inside a room it moves into the ⋯ menu with Notify.
  - Review fixes (Prism #4544, leader capture check):
    - A plain-http page, where browsers hide the worker API, now says why. Before, it returned early and said nothing.
    - The Hub's ordinary pages carry the button, not only Notices.
    - The web-dashboard and hub skills describe both controls.
    - The bare download arrow is replaced by the install icon with its name.

**Evidence** (`scripts/manual/pwa-install-s255/capture.mts`, `result.json`). Owned rigs, headless Chromium, synthetic people; no Fleet, CLI or model.

| Check | Result |
| --- | --- |
| Dashboard installable (CDP `Page.getInstallabilityErrors`, persistent profile) | `[]`: installable on localhost |
| `/sw.js` registered on the dashboard | scope `http://127.0.0.1:<port>/` |
| Sign out with the worker installed | logout 200, then `/auth/sessions` answers 401 |
| Hub over https with a self-signed certificate (browser warning clicked through) | **observed**: registration refused, 0 registrations, state `untrusted`; not simulated |

| Case | Capture |
| --- | --- |
| Fleet, desktop, light, EN: This device → Install as an app | [fleet-desk-light-en](fleet-desk-light-en.png) |
| Fleet, phone, dark, zh-TW | [fleet-phone-dark-zh-TW](fleet-phone-dark-zh-TW.png) |
| Hub, desktop, light, EN: header button / why | [button](hub-desk-light-en-button.png) · [why](hub-desk-light-en-why.png) |
| Hub, phone, dark, zh-TW: header button / why | [button](hub-phone-dark-zh-TW-button.png) · [why](hub-phone-dark-zh-TW-why.png) |

**Limits**
- Headless Chromium never draws its own install UI. On the dashboard, the page's real `beforeinstallprompt` listener was fed one synthetic event to show the Install row; Chromium's own installability verdict is the CDP line above.
- A Hub with a trusted certificate wasn't captured: that needs a CA the browser trusts. There the browser makes the real offer, and the button is the dashboard's Install path.
- Real Safari on iPhone wasn't tried. The words come from the iOS Safari user-agent case in the tests.

Tests: `tests/web-install-app-s255.test.ts` (10 cases) and `tests/web-install-app-hub-s255.test.ts` (3 cases: the chats home, a room's header beside the bell, and a phone room's ⋯ menu). Removing the room button fails 2; restoring the old insecure order fails 1. The s255 cases:
- the worker: served pre-auth, `no-cache`, no fetch or cache code;
- the offer and install, a dismissed offer, a certificate error giving `untrusted`, plain http giving `insecure`, iOS Safari, an installed window;
- the Fleet row in both locales and the Hub dialog.
A notice dialog (ui-confirm `notice: true`) has one button; a question keeps Cancel. Neighbouring web/i18n/Hub/confirm/sign-in tests: 1877 pass across 113 files. Turning off the certificate branch fails its case.
