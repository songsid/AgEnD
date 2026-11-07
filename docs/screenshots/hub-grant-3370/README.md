# Hub grants before first sign-in (#3370)

An ordinary owner can allow an eligible directory colleague immediately. The colleague has not signed in: only the exact grant is created, without a recipient person, session, pairing, room or group-provenance row. The new grant's recipient label appears on the owner's page. There is no additional confirmation.

The previous path selected only from `hub_people`. On base `46b036679`, the real fake-LDAPS positive test received 404 instead of 200; the browser left the Allow dialog open with a generic message behind it. The new path shares #3353's bounded directory selection helper and freshly checks the immutable identity. The admin-only pairing wrapper remains unchanged. The owner and displayed exposure revision are checked before directory work, then the session and exact exposure are rechecked before the audited transaction.

## Browser evidence

Chromium 156 on an owned HTTPS Hub listener and strict fake LDAPS directory. Desktop 1366×900 and phone 390×844; EN and zh-TW; light and dark. Each current case publishes a fresh exposure so its new recipient is visible. Before: 8 cases / 27 checks. Current: 8 cases plus 2 cached-shell cases / 74 checks, no browser exceptions or horizontal overflow. All 28 PNGs were inspected; the ten refreshed success captures were checked again after improving their framing.

The member publication/link and audit/content backing are the inert boundaries from `s3bRig`. The listener, TLS, session, directory driver, owner/revision checks, SQLite grant transaction, catalog projection and UI are production code. This is not a WSS/member, native CLI, model or real-account acceptance claim. The browser permits requests only to its own listener. Scratch HOME/config/tmux paths and guard executables prevent fleet or CLI access.

| State | Desktop EN light | Desktop zh-TW dark | Phone EN dark | Phone zh-TW light |
|---|---|---|---|---|
| Before: eligible recipient refused | [PNG](before-desk-en-light-eligible-refused.png) | [PNG](before-desk-zh-TW-dark-eligible-refused.png) | [PNG](before-phone-en-dark-eligible-refused.png) | [PNG](before-phone-zh-TW-light-eligible-refused.png) |
| After: allowed before first sign-in | [PNG](current-desk-en-light-allowed-before-signin.png) | [PNG](current-desk-zh-TW-dark-allowed-before-signin.png) | [PNG](current-phone-en-dark-allowed-before-signin.png) | [PNG](current-phone-zh-TW-light-allowed-before-signin.png) |
| After: unknown recipient refused inside dialog | [PNG](current-desk-en-light-unknown-refused.png) | [PNG](current-desk-zh-TW-dark-unknown-refused.png) | [PNG](current-phone-en-dark-unknown-refused.png) | [PNG](current-phone-zh-TW-light-unknown-refused.png) |

The other theme/language combinations are alongside these files. Unknown and disabled recipients use the same plain refusal, so the UI does not distinguish them. An ambiguous directory result keeps the existing bounded `unavailable` response; directory outages receive a plain retry-later message.

Old-shell SKEW retains the base's `app.css`, `app-shell.js`, `hub-owner.css`, `hub-owner-strings.js` and `hub-strings.js`, while loading the new panel and its independently registered refusal dictionary. The real listener serves the fresh module. Desktop EN dark: [success](current-skew-desk-en-dark-allowed-before-signin.png), [refusal](current-skew-desk-en-dark-unknown-refused.png). Phone zh-TW light: [success](current-skew-phone-zh-TW-light-allowed-before-signin.png), [refusal](current-skew-phone-zh-TW-light-unknown-refused.png).

## Reproduction

Run the owned fake directory with `scripts/manual/hub-directory/run.sh`, then:

```sh
AGEND_HUB_RIG_ENV=<owned-directory/rig.env> npx vitest run \
  tests/hub-directory-rig.test.ts tests/hub-grant-recipient-3370.test.ts \
  tests/hub-directory-init-lookup.test.ts tests/hub-pairing-owner.test.ts \
  tests/hub-continuation-3338.test.ts tests/hub-s3b-server.test.ts \
  tests/hub-s3b-flow.test.ts tests/hub-owner-admin-c.test.ts \
  tests/hub-ui-s3-server.test.ts tests/hub-group-message-boundaries.test.ts \
  tests/hub-group-authorization.test.ts tests/hub-group-resources.test.ts \
  tests/changelog-fragments.test.ts
npm run typecheck
npm run typecheck:tests
```

The smoke runner is `scripts/manual/smoke/smoke-hub-grant-3370.mts`; its header documents the required paths. `MODE=before REPO=<base checkout>` captures the regression. `MODE=current REPO=<feature checkout>` checks success, unknown/disabled refusal, no recipient identity/session creation, and cached-shell rendering. Private logs and fixture secrets stay in ignored `.artifacts`, never in these images.

## Local verification

On alpha-aligned head `e8bccea1623f546b10caa992d03bc4ee3dfb758b`, all 349 tests in the 13 suites above passed with no skips. Both typechecks, `git diff --check` and the changelog guard passed. The plain merge imports only alpha's unrelated structured-sign-in fix; the Hub patch used for the browser matrix is unchanged.

All 15 mutants were caught by failing assertions, with the source restored afterwards: missing pre-lookup owner/revision check; missing post-lookup exposure check; skipped fresh recipient check; wrong selected realm; wrong selected login; mismatched current immutable key; changed current login; separate operation budgets; relaxed per-login bound; omitted grant audit; missing owner/withdrawal projection fence; missing catalog session fence; omitted dialog refusal; missing public dictionary route; wrong diagnostic operation. Import or compilation failures were not counted as detections.

## Limits and rollback

Only the Hub alpha changes; main has no Hub feature to twin. No schema or protocol change. Older injected directory drivers without the additive grant method keep the known-person fallback. Existing group checks still decide whether a granted recipient may actually use an agent; granting creates no enrollment or asker provenance. Until a recipient signs in, the owner catalog resolves a missing label with one existing bounded immutable-ID check per unique recipient, without caching an allow decision. Directory failure can therefore withhold that fresh label.

Rollback is a code revert: existing immutable-key grants remain valid, while creating grants for colleagues who have never signed in returns to the known-person restriction. No database restore is required.
