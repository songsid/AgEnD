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
- This Hub can't be installed, so the frames show the **cannot-install variant**: observed, not forced.
- Off then on again shows no second notice. The phone frame uses a desktop user agent, because a phone browser offers no desktop notifications (the bell is unavailable there).

| Case | Capture |
| --- | --- |
| Desktop, light, EN | [hub-desk-light-en-keep](hub-desk-light-en-keep.png) |
| Phone width, dark, zh-TW | [hub-phone-dark-zh-TW-keep](hub-phone-dark-zh-TW-keep.png) |

Tests: `tests/hub-notify-keep-hint-s257.test.ts`, 4 cases:
- the browser-tab words, then never again;
- the installed-app words;
- the cannot-install words;
- off or a refusal says nothing.
Disabling the notice fails 2 of them. hub-room-notify tests pass. The hub skill describes the bell and the hint.
