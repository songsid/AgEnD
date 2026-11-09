# Hub poll result history (#3339)

The existing closed poll widget is the human-readable result. Its automatic continuation remains an internal agent prompt, and the shared chat thread omits its asker-authored bubble. No new styles or components: this follows `createThread` and the fleet reply-poll widget.

Real Chromium 156, real loopback Hub HTTPS/API, fake directory/member/content storage. The browser casts the vote; the member receives the exact internal prompt and returns an answer under a real release lease. No fleet, model CLI, native Windows, real directory or account. All names and identities are fixture data.

Base: `06f60b079087808fd7ffc723bced1045880ec06d`. Before and after each cover desktop 1366×900 and phone 390×844, EN/zh-TW, light/dark (8 cases each). Every case preserves the closed tally, exact agent delivery and visible agent reply, with no page errors or horizontal overflow. Screenshots show the moment after voting and before that reply.

| Surface | Language / theme | Before | After |
| --- | --- | --- | --- |
| Desktop | EN / light | [Before](before-desktop-en-light.png) | [After](after-desktop-en-light.png) |
| Desktop | EN / dark | [Before](before-desktop-en-dark.png) | [After](after-desktop-en-dark.png) |
| Desktop | zh-TW / light | [Before](before-desktop-zh-TW-light.png) | [After](after-desktop-zh-TW-light.png) |
| Desktop | zh-TW / dark | [Before](before-desktop-zh-TW-dark.png) | [After](after-desktop-zh-TW-dark.png) |
| Phone | EN / light | [Before](before-phone-en-light.png) | [After](after-phone-en-light.png) |
| Phone | EN / dark | [Before](before-phone-en-dark.png) | [After](after-phone-en-dark.png) |
| Phone | zh-TW / light | [Before](before-phone-zh-TW-light.png) | [After](after-phone-zh-TW-light.png) |
| Phone | zh-TW / dark | [Before](before-phone-zh-TW-dark.png) | [After](after-phone-zh-TW-dark.png) |

[Before receipt](before.json), [after receipt](after.json). The phone EN/light image was recaptured with [composer geometry](composer-geometry.json): input y710–748 within the 844px viewport. Both that image and the phone zh-TW/dark image were visually checked for the composer and tally.

SKEW: the base `hub-chat-store.js` served with the fixed server also exposes no prompt and retains the answer ([receipt](after-skew.json), [phone image](after-skew-phone-zh-TW-dark.png)). That cached old renderer may still draw an empty outgoing bubble. The explicit empty `question` replaces a cached prompt when its entry is read again; an already settled entry in an already open tab may require a reload. The current renderer omits the bubble entirely.

## Reproduce

```sh
REPO="$PWD" OUT=/tmp/hub-poll-3339 PW_DIR=/path/to/playwright-install \
CHROME=/path/to/chromium FONTCONFIG_FILE=/etc/fonts/fonts.conf MODE=after \
node --import tsx scripts/manual/smoke/smoke-hub-poll-3339.mts
```

Use `MODE=before` with the base source for the initial leak. `ONLY=phone-en-light` selects one case. `OLD_STORE=/path/to/base-hub-chat-store.js` serves the cached old module against the current API. The script closes its browser, listener and rig and removes its temporary TLS identity in `finally`; receipts and screenshots contain no pairing or session secrets.

Fail-first: the new server and renderer regressions both fail on the base. Mutating away server suppression fails the server assertion; removing the renderer's `pollResult` guard fails both the mapping and cached-entry regression. The server test also verifies restart, a page without the original poll, exact result delivery, visible answer/tally, and an ordinary typed question with identical prompt text.
