# Asking an owner for an agent — A1

The manager can search for a person after an empty agent search, send a private optional hint, see a waiting row and cancel it. Selecting a person reveals no agent inventory and adds neither a person nor an agent to the room.

This is an **unmounted foundation**. Standard server composition has no request schema, routes or feature offer. The optional test composition exercises the complete manager path; owner responses, production registration, protected-note retention and role inventory integration belong to A2. See the [API and mounting requirements](../../design/hub-room-owner-requests-api.md).

## Validation

- Source and test TypeScript checks: exit 0.
- Ten focused and regression files: **243/243 passed**, including HTTP composition, legacy consent, invitation visibility, room settings/new-room/client, and the three new request files (**31 new cases**).
- After syncing the personal-pins alpha change, five integration files passed **57/57**, including personal pins and the new request suites; source TypeScript was rechecked (exit 0). Both features are preserved.
- Five negative controls were caught: removing the daily limit, owner opt-out, private hint binding, duplicate-submit guard or late-session response guard makes its matching assertion fail. All changes were restored before the green regression batch. Results: [controls.json](controls.json).
- Changelog assembly check: exit 0 after correcting the fragment front matter.
- Real-app headless walk: **39 checks**, EN and zh-TW at 1366×900 and 390×844, through actual Hub HTTPS, SQLite, encrypted audit and shipped UI modules. The only directory is synthetic; no agents or Fleets exist. All four requests and cancellations persist through their real routes. No external request, page error, agent publication or member delivery occurred.

The first capture attempt lacked a Chinese font and did not frame the empty-search entry. Those images were replaced after adding a Traditional Chinese font to the disposable browser home and scrolling the entry into view. Product source did not change for that correction.

## Rendered views

Each set contains empty agent search, person selection, the request dialog and the waiting row:

| View | Desktop | Phone |
|---|---|---|
| EN empty search | [PNG](browser/desk-en-empty-search.png) | [PNG](browser/phone-en-empty-search.png) |
| EN person selection | [PNG](browser/desk-en-choose-person.png) | [PNG](browser/phone-en-choose-person.png) |
| EN request | [PNG](browser/desk-en-request.png) | [PNG](browser/phone-en-request.png) |
| EN waiting | [PNG](browser/desk-en-waiting.png) | [PNG](browser/phone-en-waiting.png) |
| zh-TW empty search | [PNG](browser/desk-zh-TW-empty-search.png) | [PNG](browser/phone-zh-TW-empty-search.png) |
| zh-TW person selection | [PNG](browser/desk-zh-TW-choose-person.png) | [PNG](browser/phone-zh-TW-choose-person.png) |
| zh-TW request | [PNG](browser/desk-zh-TW-request.png) | [PNG](browser/phone-zh-TW-request.png) |
| zh-TW waiting | [PNG](browser/desk-zh-TW-waiting.png) | [PNG](browser/phone-zh-TW-waiting.png) |

The [browser receipt](browser/receipt.json) records assertions and served asset hashes. The source revision is the pre-commit base; its diff hash records tracked working changes at capture time. Served asset hashes identify the actual UI bytes, including new modules.

Reproduce with `scripts/manual/hub-room-owner-requests-m3341/browser.mts`, supplying `CHROME` (a Linux Chromium binary), `PW_DIR` (a local playwright-core package), `CJK_FONT` (Noto Sans CJK Traditional Chinese) and optional `OUT`. The harness owns its loopback listeners, browser, SQLite data, home and TLS material, and closes/removes them in `finally`. Certificate-error acceptance applies only to its disposable browser context; it does not change an operator trust store.

## Limits and rollback

The proof uses inert directory data and no real identity provider, Fleet, CLI, model, Windows process or desktop window. It proves the optional manager request path, not owner acceptance or production activation. The migration is not registered, so this slice changes no deployed database. A compatible rollback is to keep optional composition absent; A2 must document upgrade/downgrade once registration is introduced. No request forwarding is implemented.
