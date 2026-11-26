# S-257 step 1: keep Hub notifications coming

Base: release/2.3.5-alpha (c544873e5). The leader asked for step 1 only. Web Push and email wait for the user's answer
about outbound access from the Hub VM (design note on M-3828).

**What changed**
- **The bell's own words** (Notify me on this device) now say notifications come "while a Hub tab or the AgEnD app is open, even in the background".
- **The first time Notify goes on** on a device (header bell, or the room ⋯ menu on a phone), the app's one-button notice (S-255) says what keeps notifications coming. There are three variants:
  - **Browser tab:** closing every Hub tab stops them. Install the Hub as an app (the button beside the bell) and leave it running, minimized is fine; in Edge or Chrome, the app's settings offer "Start app when you sign in".
  - **Installed app:** quitting it stops them. Leave it running; "Start app when you sign in" keeps it there after a restart.
  - **A Hub this browser can't install** (untrusted certificate, plain http): keep a Hub tab open; the app isn't offered yet, and the button beside the bell says why.
- It shows once per device (`agend_hub_notify_kept`). Turning Notify off, or a browser refusal, shows nothing.
- No new notification mechanism: the existing popup (hub-room-notify) works while a Hub tab or the app is open.

**Captures** (`scripts/manual/hub-notify-keep-s257/capture.mts`, `result.json`):
- The real Hub (hub-s3b-rig) over HTTPS with an owned self-signed certificate, headless Chromium, notifications granted, synthetic people.
- Off then on again shows no second notice. The phone frames use a desktop user agent, because a phone browser offers no desktop notifications (the bell is unavailable there).
- **Untrusted** (this Hub as it is): observed, not faked.
- **Browser tab on an installable Hub:** the fixture fakes only a worker registration that succeeds, as it does on a trusted certificate, plus one synthetic `beforeinstallprompt`. The install button then stands beside the bell.
- **Installed app:** the fixture fakes only the window's `display-mode: standalone`. The page's own state is asserted for each (`none` / `installed`).
- **The bell's own words** are its tooltip (`title`). Headless Chromium doesn't paint native tooltips, so the fixture draws that exact title text under the bell, before and after turning it on. The attribute values are in `result.json`.

| Case | Desktop, light, EN | Phone width, dark, zh-TW |
| --- | --- | --- |
| Bell text, off | [bell-off](hub-desk-light-en-bell-off.png) | [bell-off](hub-phone-dark-zh-TW-bell-off.png) |
| Bell text, on | [bell-on](hub-desk-light-en-bell-on.png) | [bell-on](hub-phone-dark-zh-TW-bell-on.png) |
| Notice: Hub can't be installed (observed) | [keep](hub-desk-light-en-keep.png) | [keep](hub-phone-dark-zh-TW-keep.png) |
| Notice: browser tab, installable Hub (faked trust) | [tab](hub-desk-light-en-tab-keep.png) | [tab](hub-phone-dark-zh-TW-tab-keep.png) |
| Notice: installed app (faked display-mode) | [app](hub-desk-light-en-app-keep.png) | [app](hub-phone-dark-zh-TW-app-keep.png) |

The cannot-install wording is plainer after the leader's capture check: "its address doesn't have a certificate your company's computers trust" / 「它的網址還沒有公司認可的憑證」.

Review fixes (Prism #4548):
- The action and its words live in a new module, `hub-notify-keep.js` (its own `hubkeep` strings, both locales; in HUB_UI_MODULES). A tab holding the previous hub-room-notify.js or hub-room-strings.js still links and still reads the words.
- A refused storage still shows it once per page.
- `tests/hub-notify-keep-skew-s257.test.ts` links the room's import against the RETAINED base hub-room-notify.js (fixture at c544873e5) in Node's real ESM linker. The control (importing the action from the old file) fails to link.

Tests: `tests/hub-notify-keep-hint-s257.test.ts`, 7 cases (adds both locales' own words and the storage fallback; removing the per-page guard fails it). The original cases:
- the browser-tab words, then never again;
- the installed-app words;
- the cannot-install words;
- off or a refusal says nothing.
Disabling the notice fails 2 of them. hub-room-notify tests pass. The hub skill describes the bell and the hint.
