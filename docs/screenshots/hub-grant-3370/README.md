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
  tests/hub-init-rig.test.ts tests/hub-compose-rig.test.ts tests/hub-directory-unit.test.ts \
  tests/hub-directory-init-lookup.test.ts tests/hub-pairing-owner.test.ts \
  tests/hub-continuation-3338.test.ts tests/hub-s3b-server.test.ts \
  tests/hub-s3b-flow.test.ts tests/hub-owner-admin-c.test.ts \
  tests/hub-ui-s3-server.test.ts tests/hub-group-message-boundaries.test.ts \
  tests/hub-group-authorization.test.ts tests/hub-group-resources.test.ts \
  tests/hub-shared-modules-a.test.ts tests/changelog-fragments.test.ts \
  tests/web-settings-search-2347.test.ts tests/settings-hub-section-a7b.test.ts
npm run typecheck
npm run typecheck:tests
```

The smoke runner is `scripts/manual/smoke/smoke-hub-grant-3370.mts`; its header documents the required paths. `MODE=before REPO=<base checkout>` captures the regression. `MODE=current REPO=<feature checkout>` checks success, unknown/disabled refusal, no recipient identity/session creation, and cached-shell rendering. Private logs and fixture secrets stay in ignored `.artifacts`, never in these images.

## Initial verification

On alpha-aligned head `e8bccea1623f546b10caa992d03bc4ee3dfb758b`, all 349 tests in the 13 suites used at that point passed with no skips. Both typechecks, `git diff --check` and the changelog guard passed. The plain merge imports only alpha's unrelated structured-sign-in fix; the Hub patch used for the browser matrix is unchanged.

All 15 mutants were caught by failing assertions, with the source restored afterwards: missing pre-lookup owner/revision check; missing post-lookup exposure check; skipped fresh recipient check; wrong selected realm; wrong selected login; mismatched current immutable key; changed current login; separate operation budgets; relaxed per-login bound; omitted grant audit; missing owner/withdrawal projection fence; missing catalog session fence; omitted dialog refusal; missing public dictionary route; wrong diagnostic operation. Import or compilation failures were not counted as detections.

## Review correction: all selection outcomes

The first review found an in-flight disclosure gap: null/self recipient selections returned 404 before the final session/exposure fence. A held eligible result after browser revocation returned 401, while an unknown result still returned 404. This did not create a grant, but exposed the admitted lookup's outcome after authority ended.

Selection now settles into a value or bounded error. Server/session checks run first; the same transaction then rechecks ownership, exact revision and publication before either interpreting a refusal/error or creating the audited grant. There is no extra lookup or confirmation. Thirty held-result controls cover eligible, unknown, ineligible, self and unavailable selections against session, owner, revision, withdrawal, freeze and server changes. Against the original head, 17 assertions failed and 13 controls passed; they all pass after the correction. The explicit Hub module-list test also includes the intentionally new, separately served refusal dictionary.

The corrected code passes **382/382 tests across 14 suites with zero skips**, both typechecks and the diff check. All **18/18 mutants** fail assertions with source restored, including early negative disclosure, early error disclosure and missing server fencing. Import/build errors are not counted.

The correction changes server ordering and tests only. The inspected 28-PNG UI/cached-shell matrix above carries unchanged; no UI, dictionary or CSS files changed during this review correction.

## CI fixture isolation

The R2 CI `hub-directory` job failed the relay's shared `alice` positive sign-in (43 passed, 1 failed). The concurrent compose test temporarily disabled that same seed user. A deterministic control added during the lock fails with the original fixture; on the pre-feature base `46b036679b51492f590796d7cb7d9c4c8040eddb`, the control explicitly reports `not-eligible`. The base file was restored after that probe. This proves the fixture interference; the original CI log does not contain the directory refusal reason, so it does not establish the exact scheduling cause of that run.

The compose suite now creates a unique administrator, uses its immutable ID throughout initialization/sign-in/disable, and removes only that entry afterwards. While that administrator is disabled, its own web request is still refused and the shared Alice control must remain eligible. No timeout, delay, worker setting, serialization, skip or production code changed. Reintroducing the old shared-seed fixture fails that positive control; the source is restored after the mutation.

Both directory CI commands pass locally against the owned strict-LDAPS container: the four-file command passes 44 tests; the second three-file JSON check passes 27 with zero pending. The original grant tests and inspected PNG matrix carry unchanged.

The same CI run also found registry coverage collecting the Hub section before its lazy membership card finished loading (`hub.membership (#hubMemberEnabled)` absent). That fixture now awaits the actual module import and supplies the normal disabled-membership response. It still checks the same registry IDs and keeps the same timer flush count; no timeout increase or absent-field exemption.

An initial combined local run alongside two typechecks hit the continuation suite's 10-second cold-import hook limit (381 passed, 22 pending, one failed suite), so it was not counted as green. The isolated settings/section/continuation rerun passed 48 tests; the final combined check passes **429/429 tests across 19 suites with zero skips**, without competing typecheck processes. No timeout setting was changed. The previous 18 source mutants carry unchanged; the shared-seed fixture mutation provides an additional assertion-detected regression control. Both typechecks pass.

## Limits and rollback

Only the Hub alpha changes; main has no Hub feature to twin. No schema or protocol change. Older injected directory drivers without the additive grant method keep the known-person fallback. Existing group checks still decide whether a granted recipient may actually use an agent; granting creates no enrollment or asker provenance. Until a recipient signs in, the owner catalog resolves a missing label with one existing bounded immutable-ID check per unique recipient, without caching an allow decision. Directory failure can therefore withhold that fresh label.

Rollback is a code revert: existing immutable-key grants remain valid, while creating grants for colleagues who have never signed in returns to the known-person restriction. No database restore is required.
