# H3: a room purpose

Rooms had no short, shared explanation of their purpose. Managers can now set an optional one-line purpose of up to 200 visible characters at creation or in Room settings. Members see it below the room name, at the top of Members and in their room list/search. Tapping the header opens the full text. Named system messages record setting and clearing it, localized from stored metadata rather than parsed prose.

## Acceptance and checks

- Manager-only writes and member-only visibility; outsider list/detail stays unavailable. The value is NFC-normalized, control/bidi characters become spaces, and the cap counts graphemes, including joined emoji. Empty clears it.
- The purpose and each system message's original value persist in SQLite. The audit transaction binds message content to its audit record. Re-saving an unchanged purpose adds no extra purpose event.
- New-room controls require the browser feature and client capability. Older Hubs keep the previous request shape. Old Fleet room list/member frames remain strictly parseable without a structured purpose field; H4/H5 add their separately negotiated agent views later.
- A failed settings save preserves the edit for retry. Header tap shows full text, without nesting forms or changing room permissions.

Fail-first: three HTTP cases failed on the H2 base because its strict API rejected the new field. After the fix, the affected existing ten-file set passed **115/115**. The final API/UI/skill set passed **20/20** (including the added strict legacy-frame check), and the existing search UI file passed **5/5**. Source and test typechecks pass. These counts overlap; they are not summed.

```
npx vitest run tests/hub-room-purpose-h3.test.ts tests/hub-room-purpose-ui-h3.test.ts tests/hub-skill.test.ts
npx vitest run tests/hub-room-search-ui-m3127.test.ts
npm run typecheck
npm run typecheck:tests
```

The existing set covers room system messages/migration, new-room/settings/members/list/thread UI, browser feature lists and serving inventory. The historical registry test intentionally omits the base rooms component and now also omits its dependent purpose component.

## Real Hub browser evidence

The harness in `scripts/manual/hub-room-purpose-h3/browser.mts` uses owned HTTPS/SQLite/audit, synthetic directory accounts and headless Linux Chromium. It checks create, header, tap-full, Members and settings save on desktop EN/light and phone zh-TW/dark. No real account, vendor CLI, model call, live Fleet, Windows process or visible window. Foreign requests are blocked.

| View | Desktop EN/light | Phone zh-TW/dark |
|---|---|---|
| Create | [PNG](desk-light-en-create.png) | [PNG](phone-dark-zh-TW-create.png) |
| Room header | [PNG](desk-light-en-room.png) | [PNG](phone-dark-zh-TW-room.png) |
| Full purpose | [PNG](desk-light-en-full.png) | [PNG](phone-dark-zh-TW-full.png) |
| Settings | [PNG](desk-light-en-settings.png) | [PNG](phone-dark-zh-TW-settings.png) |

`receipt.json` records the base commit plus checks against the working tree. `source-sha256.txt` binds the checked source files; the PR head additionally binds the whole packet.

## Risk and rollback

The additive `s3-room-purpose` migration depends on the base rooms migration. It adds no Fleet wire fields, delivery behavior or agent prompt. Rollback across this schema version needs the pre-migration database backup because an older binary can refuse a newer registered component. Removing a purpose through the UI is a normal manager edit; historical system messages remain historical.
