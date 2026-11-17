# H1: explicitly published agent introductions

The Hub previously had no public introduction field. Fleet descriptions remain private catalog data. This slice adds independent Hub storage and an owner save; it does not copy descriptions into public fields automatically.

## Acceptance

- Owner-only PUT `/hub/v1/exposures/:id/intro` checks the existing exposure revision and CSRF/session; edits do not revise exposure consent or grants. Last write wins, with source and timestamp.
- Fifty visible graphemes, including joined emoji, fit. Fifty-one are refused. Text is normalized to one plain-text line; @ is text.
- The introduction appears in owner rows, agent choices, direct chat headings, room member rows/cards, mentions and the person-facing agent list. Existing owner/source and Answer only labels remain.
- Existing personal descriptions stay private on reads. The owner sees a 50-character starting value and review/cut notices. An explicit save replaces the old display-only description and publishes the introduction together. Description is not used as worker instructions.
- Old Fleet reports, strict member frames, catalog digest/incarnation and sharing-retention images are unchanged. No automatic defaults, existing-share notice or agent-side tool is included; those belong to H2.

## Verification

Fail-first on base `6acab70d`: both new HTTP tests failed (missing empty intro and PUT returned 404). After implementation, the 12 focused files passed **153/153**. The new UI tests cover explicit save, failure retaining edits, grapheme limit and the real client's PUT/CSRF encoding. The personal tests cover the old private description and explicit review flow.

```
npx vitest run tests/hub-agent-intros-h1.test.ts tests/hub-agent-intros-ui-h1.test.ts tests/hub-personal-ui-m3224.test.ts tests/hub-personal-owner-m3224.test.ts tests/hub-personal-http-m3224.test.ts tests/hub-personal-schema-m3224.test.ts tests/hub-quota-server.test.ts tests/hub-shared-modules-a.test.ts tests/hub-room-members.test.ts tests/hub-room-compose-track-c.test.ts tests/hub-room-list-3092.test.ts tests/hub-ui-s3.test.ts
npm run typecheck
npm run typecheck:tests
```

`browser.mts` starts a real HTTPS Hub over SQLite with a synthetic directory and Fleet. Chromium runs headless. No real account, vendor CLI, model request or live Fleet is used. Desktop EN/light and phone zh-TW/dark each pass owner Save → public catalog → reader's direct chat. No page errors or foreign requests. Captures labelled before/after show an empty introduction versus the explicitly saved value on the implementation, not different source builds.

| View | Desktop EN/light | Phone zh-TW/dark |
|---|---|---|
| Before owner save | [PNG](desk-light-en-before.png) | [PNG](phone-dark-zh-TW-before.png) |
| After owner save | [PNG](desk-light-en-after.png) | [PNG](phone-dark-zh-TW-after.png) |
| Reader chat | [PNG](desk-light-en-reader.png) | [PNG](phone-dark-zh-TW-reader.png) |

All six images were inspected; the refreshed desktop spacing and wrapped phone introduction are clear. The browser receipt records the base checkout SHA; `source-files.sha256` identifies the source and tests submitted for review. Later final changes only preserve existing list attribution and fence the save against a retired session.

## Migration and rollback

Independent component `s3-agent-intros` creates an empty table; no description backfill. H1 retains existing private text until Save. The ordinary migration registry refuses an older build that cannot read this component. To roll back the binary, restore its pre-migration Hub database backup; do not remove tables from a running Hub. No Fleet configuration changes.

The [design note](../../design/hub-room-agent-context.md#52-paste-size-measurements) records the system/bundled tmux paste results requested after H7.
