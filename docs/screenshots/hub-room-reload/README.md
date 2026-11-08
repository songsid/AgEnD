# Hub room-history reload acceptance

Product source: `48a305f7621c7b2f1977ee086e8fd03acc2d248d`, alpha base `9b06e6bdb5de10599a0060567956c8ced4a32203`.
The later evidence/manual-retained-module commit does not change product or automated-test bytes.

## Root cause and fix

A room/session timestamp rejected every second history read within ten seconds. A reload creates a new store but retains the authenticated session, so ordinary reload/reopen received 429. This is a product pacing/UX bug, not a browser timing failure.

Keep the normal client ten-second poll interval. Server reads now share a bounded **session-wide** allowance: burst eight, one replenished every 1.25 seconds, at most two physical reads in flight, and at most 8192 retained buckets. Rooms and cursors share it; refusals do not refill it; only fully replenished idle buckets can be evicted. This bounds work across rooms, unlike the old room-specific timestamp. Fresh pages get room to initialize/reload without a history/permission cache. Every accepted read still checks the session, exact asker, owner eligibility, group permit, room and current grant. Grant expiry is checked after awaited eligibility and again before disclosure. Each page remains capped at 100 entries.

Real excess requests remain 429 with Retry-After 10. The chat uses the existing `.hub-banner.warn` and existing `hr("busy")` translation; its existing store retries automatically. There are no new controls, confirmation steps, settings or translations. Surface: Hub web chat, desktop and phone. The existing busy strings/export predate this change, so the new panel also works with the retained dependency module.

## Browser evidence

Real Chromium, HTTPS listener, SQLite, session sign-in, owner grants, room creation, question dispatch, release lease and answer acceptance. The test directory and in-process protocol member are synthetic; no API response replacements, real AD, real accounts, model CLI, native runtime, pilot or live fleet. This is not load sizing or an end-to-end member-process claim.

`before/`: all eight combinations of desktop/phone, light/dark, EN/zh-TW reproduce the original immediate-reload 429 (673–2145 ms after the first read). The baseline receipt's PASS means the expected failure was reproduced, not that the old product worked.

`current/`: all eight combinations pass four checks each: reload shows the actual question/answer, reopen shows it, two explicitly held real reads make a third return 429/Retry-After 10 with the plain localized busy notice, and releasing those reads lets the browser recover automatically. Reload happens 692–2409 ms after the first read; reopen 1771–4900 ms. All are within ten seconds. Eight visible, eight busy and eight recovered PNGs are retained. No page errors, CSP violations or foreign-origin requests were observed in the candidate campaign.

`skew/`: baseline `panel-hub.js` served as the retained static module against the new server. Desktop/light/EN and phone/dark/zh-TW both reload/reopen successfully within ten seconds, without page errors, CSP violations or foreign-origin requests. This two-cell check covers old-panel/new-server compatibility, not the new busy wording in an old cached panel.

All 32 before/current PNGs were inspected; composer/history, identity and limitations remain legible without horizontal overflow in both themes/languages. `cleanup.json` independently confirms all three runner PIDs absent, listener ports bindable and generated key directories absent. The temporary keys/homes are not included.

## Automated checks and reversals

- `fail-first.log`: the new immediate-reload HTTP test fails on the old pacing rule (expected 200, received 429).
- `focused-final.log`: four suites, **61/61**, zero skips. Covers reload/new history; grant revoke; disabled owner; signout; expiry across awaited eligibility and final projection; session-wide room/cursor budget; explicit held-read gate; replenishment, backward clock, capacity and release identity.
- `hub-suites-final.log`: printed **114 passing files, 1719 passing tests; 3 files/27 tests skipped** by their existing opt-in gates, then the process returned **143**. This is assertion-output evidence, **not a clean command success**; no root cause for that post-summary signal is claimed. The earlier 1718-test run exited 0 before the final disclosure-expiry assertion/check was added; the exact final check is covered by the clean focused run. Full clean CI remains required.
- `ui-policy.log`: three suites, **30/30**, zero skips, exit 0 (CSP, locale literals and shared modules).
- Build and test TypeScript checks pass.
- `mutations.json` and six logs: six isolated reversals each fail actual assertions, then restored: remove token bound, remove physical bound, double release, evict spent buckets, key allowance by room, remove final grant-expiry disclosure check. No compile-error result is counted as a caught mutant.

Focused command:

```sh
node node_modules/vitest/vitest.mjs run tests/hub-room-read-pacer.test.ts tests/hub-room-reload.test.ts tests/hub-s3b-server.test.ts tests/hub-chat-b.test.ts --reporter=verbose
npm run typecheck
npm run typecheck:tests
```

Browser recipe, using an owned scratch HOME/TMPDIR and a private Chromium installation:

```sh
REPO="$PWD" OUT="<owned-output>" PW_DIR="<playwright-node_modules>" \
CHROME="<chromium-executable>" HOME="<owned-home>" TMPDIR="<owned-tmp>" \
node --import tsx scripts/manual/smoke/smoke-hub-room-reload.mts
```

The script uses only its own loopback listener and tears down browser/listener/rig/keys in finally. For baseline use `REPO=<detached-base-checkout> BASELINE=1`; for retained-panel use `MATRIX=quick RETAINED_PANEL=<base-panel-hub.js>`. The runner script comes from the candidate checkout in both cases. No privileged container, account, vendor API or fleet lifecycle operation is needed.

Risk: the server deliberately permits a larger short burst than the former cooldown, while bounding sustained reads and concurrent work per session and preserving existing global directory admission. Sustained abuse still sees busy/retrying. Rollback: revert this PR; no schema, persisted history or credential migration.
