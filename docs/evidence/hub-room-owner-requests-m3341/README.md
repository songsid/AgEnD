# Asking an owner for an agent — A1

The manager can search for a person after typing an agent search, send a private optional hint, see a waiting row and cancel it. Selecting a person reveals no agent inventory and adds neither a person nor an agent to the room.

This is an **unmounted foundation**. Standard server composition has no request schema, routes or feature offer. The optional test composition exercises the complete manager path; owner responses, production registration, protected-note retention and role inventory integration belong to A2. See the [API and mounting requirements](../../design/hub-room-owner-requests-api.md).

## Validation

- Source and test TypeScript checks: exit 0.
- Ten focused and regression files: **243/243 passed**, including HTTP composition, legacy consent, invitation visibility, room settings/new-room/client, and the three new request files (**31 new cases**).
- After syncing the personal-pins alpha change, five integration files passed **57/57**, including personal pins and the new request suites; source TypeScript was rechecked (exit 0). Both features are preserved.
- Five negative controls were caught: removing the daily limit, owner opt-out, private hint binding, duplicate-submit guard or late-session response guard makes its matching assertion fail. All changes were restored before the green regression batch. Results: [controls.json](controls.json).
- Changelog assembly check: exit 0 after correcting the fragment front matter.
- Real-app headless walk: **45 checks**, EN and zh-TW at 1366×900 and 390×844, through actual Hub HTTPS, SQLite, encrypted audit and shipped UI modules. The directory is synthetic. One in-process owned exposure is used only for the additional matching-result view; there is no live Fleet or model. All four requests and cancellations persist through their real routes. Waiting rows also survive closing/reopening settings with an empty search. No external request, page error, agent publication or member delivery occurred.

The first capture attempt lacked a Chinese font and did not frame the empty-search entry. Those images were replaced after adding a Traditional Chinese font to the disposable browser home and scrolling the entry into view. Product source did not change for that correction.

## Copy and interaction revision

The owner dialog now uses separate title/field labels; after choosing a person it shows one Owner chip, and removing that chip restores the search. Chinese spacing and request terminology follow the rendered-copy feedback. The owner-request entry also appears beneath nonempty results whenever search text is present. Add-members and owner pickers retain their existing name-only person rows.

The changed UI and two existing room suites pass **29/29**; the test typecheck passes. Two additional controls are caught: restoring the second search input, and hiding the entry under other matching results. The restored request UI suite passes **10/10**. Backend source is unchanged. Results: [pm-r1-controls.json](pm-r1-controls.json).

## Paging correction

A superseded Load more response is fenced by its page/room generation. Three mounted held-response cases fail before the fix; the affected regression set passes 27/27 afterward, and dropping the generation guard makes all three red. Restored UI 13/13 and test typecheck pass. See [the interleavings and limits](paging.md). Copy, markup, backend and accepted PNGs are unchanged.

## CI fixture repair

Exact-head CI run 44356495851 exposed one remaining deterministic fixture mismatch: the shared-module test pinned the serving list before the two new owner-request modules were added. The expected list now includes both files in their actual order. The failing file passes **11/11** locally. Runtime source, scripts, templates, changes and CI configuration are byte-identical to the cleared 74ff7df head; no cleared source, mutation or browser campaign was repeated.

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
| zh-TW other matches | — | [PNG](browser/phone-zh-TW-other-matches.png) |

The [browser receipt](browser/receipt.json) records assertions and served asset hashes. The source revision is the pre-commit base; its diff hash records tracked working changes at capture time. Served asset hashes identify the actual UI bytes, including new modules.

Reproduce with `scripts/manual/hub-room-owner-requests-m3341/browser.mts`, supplying `CHROME` (a Linux Chromium binary), `PW_DIR` (a local playwright-core package), `CJK_FONT` (Noto Sans CJK Traditional Chinese) and optional `OUT`. The harness owns its loopback listeners, browser, SQLite data, home and TLS material, and closes/removes them in `finally`. Certificate-error acceptance applies only to its disposable browser context; it does not change an operator trust store.

## Limits and rollback

The proof uses inert directory data and no real identity provider, Fleet, CLI, model, Windows process or desktop window. It proves the optional manager request path, not owner acceptance or production activation. The migration is not registered, so this slice changes no deployed database. A compatible rollback is to keep optional composition absent; A2 must document upgrade/downgrade once registration is introduced. No request forwarding is implemented.
