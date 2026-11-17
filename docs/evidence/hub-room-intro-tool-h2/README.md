# H2: negotiated introduction defaults and self-editing

H1 supplied an owner field. Fleets still lacked a negotiated default/self-edit path, a durable daily limit and an owner notice for existing private descriptions becoming public. H2 adds those paths without changing exposure consent or the private catalog's digest/incarnation image.

## Acceptance

- `agent-intro-v1` is a Hub-only welcome offer with explicit member opt-in; it adds no member hello slot. Old peers receive no new frames. An old Hub produces the clear unsupported tool result.
- `hub_set_intro({text})` is self-only, uses the current daemon caller and existing local consent, and maps to that agent's current exposure. Agent/default wire sources cannot claim an owner edit. Fifty visible graphemes; empty clears it.
- The Hub counts five actual agent changes per UTC day in SQLite. An operation retry does not consume a second change; reusing an operation for different input is refused. Owner edits are unlimited. Defaults never replace any existing introduction, including an explicitly empty one.
- Defaults take only the first description line, cut at 50 graphemes. The member sends them serially in the background after reconciliation or a publication; startup and tool listing do not await them. A tool's uncertain RPC result is not called a refusal and is never automatically retried as a fresh edit.
- Sharing access shows each accepted agent's introduction and Edit in both common and individual flows. Inline Save has no nested form and does not grant access. Existing previous-access controls, sharing request/ACK/Undo shapes and their grant loop are preserved.
- A migration marks existing Fleet shares without an explicit introduction. Their first nonempty default adds one persistent owner notice with page links. A later Fleet's backfill reopens the same card, naming that Fleet and listing only newly filled agents. Reconnects, retries, ordinary edits and new shares do not reopen it. Personal descriptions retain H1's explicit-owner-Save behavior.

## Verification

Fail-first: the two new HTTP tests failed on the H1 base because `agent.intro` had no receiver/result. After implementation, 14 focused files passed **159/159**. The later PM clarification is pinned separately: tool/notice UI files pass **12/12**, including owner acknowledgement followed by another Fleet's backfill. Source and test typechecks pass.

The focused set covers Hub persistence, owner isolation, grapheme/default handling, restart/day boundaries, member caller fencing and serial default delivery, actual stdio MCP calls, native/profile parity, static-list startup, sharing UI/API, feature lists, serving inventory and the Hub skill. One owned TLS/WSS rig verifies the actual negotiated frame exchange and legacy refusal; no real Fleet process or vendor runs.

```
npx vitest run tests/hub-agent-intro-tool-h2.test.ts tests/hub-agent-intro-member-h2.test.ts tests/hub-agent-intro-ui-h2.test.ts tests/hub-agent-intro-link-h2.test.ts tests/hub-room-post-mcp.test.ts tests/native-mcp.test.ts tests/tool-permissions.test.ts tests/hub-native-catalog-m3184.test.ts tests/mcp-tool-list-startup-m3183.test.ts tests/hub-share-page-ui-m3294.test.ts tests/hub-share-page-api-m3294.test.ts tests/hub-groups-mount-s89.test.ts tests/hub-shared-modules-a.test.ts tests/hub-skill.test.ts
npm run typecheck
npm run typecheck:tests
```

The browser harness uses real HTTPS/SQLite/audit and the actual local sharing writer with an inert in-process member transport, synthetic directory and identities. Chromium is headless on Linux. It checks the existing-share notice/acknowledgement, sharing preview and explicit owner edit. The form-isolation unit test separately pins that intro Save never submits the surrounding grant form. No page errors, foreign requests, nested forms or horizontal overflow. No account, vendor CLI, model call, live Fleet or Windows window.

| View | Desktop EN/light | Phone zh-TW/dark |
|---|---|---|
| Existing-share notice | [PNG](desk-light-en-notice.png) | [PNG](phone-dark-zh-TW-notice.png) |
| Sharing preview | [PNG](desk-light-en-preview.png) | [PNG](phone-dark-zh-TW-preview.png) |
| Expanded editor | [PNG](desk-light-en-editor.png) | [PNG](phone-dark-zh-TW-editor.png) |
| Saved introduction | [PNG](desk-light-en-edited.png) | [PNG](phone-dark-zh-TW-edited.png) |

Captures were inspected. A fixture-only missing invitation service was corrected before the final captures. The receipt identifies the base checkout; source hashes identify the submitted implementation. The screenshots show the first batch; later-batch wording and persistence are covered by the focused tests.

## R1: historical schema compatibility

Exact CI found historical registries that intentionally omit personal-agent migrations. Their exposure table has no `source_kind`, so the new backfill originally failed. A fail-first regression reproduced that failure. The migration now checks `PRAGMA table_info`: without the discriminator, all historical rows are Fleet shares; modern schemas keep the Fleet-only predicate. Withdrawn rows and explicit introductions remain excluded.

The exhaustive Classic outbound-tool table also now includes `hub_set_intro` as a non-channel-addressed tool. The intro tool, Classic table, personal schema, sharing-pause migration and room migration files pass **120/120**. No browser, stdio or TLS rig was rerun for this narrow repair.

## Risks and rollback

A default intentionally makes the first line public; the preview and persistent review notice are part of this feature. Defaults and edits stay separate from Fleet instructions, private inventory identity, grants and Undo retention. Five changes means UTC days, not a rolling 24-hour window. A lost edit acknowledgement remains uncertain.

Independent migration `s3-agent-intro-tool` adds counters, operation outcomes, existing-share markers and the owner notice. Older builds refuse that component. Binary rollback uses the pre-migration Hub database backup; do not remove live tables. No Fleet configuration or live account changes.
