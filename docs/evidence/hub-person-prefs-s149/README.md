# S-149 — personal Hub favourites

Source commit: `07625f1b027a4319ae84aced4213e9475a22c777`. Base: alpha `eacc64084e587870fa5a350fec7992b5b4602ba6`.
Draft implementation; hold the PR until beta.1 ships and the Leader lifts the alpha freeze. No merge or release claim.

## Behaviour and API

S-145 kept favourites per browser/login behind its `favoritesSource`. This change replaces that source on a Hub that
advertises `person-prefs-v1`. Existing row menus, ordering, 50-item limit and exports stay in place. An older Hub, or
an older cached favourites module, retains the local source. No markup, styles, new controls or extra EventSource.

- Migration `s3-person-prefs` v1 appends `hub_person_prefs` to existing `hub.sqlite`; its primary/foreign key is the
  immutable signed-in directory person from `hub_people`, not the login label.
- `GET /hub/v1/me/prefs` returns `{favorites, initialized, revision}`. An absent row is `[], false, 0`.
- `PUT /hub/v1/me/prefs` takes `{favorites, onlyIfUnset?}` and returns the stored view. Only the signed-in person can
  select the row; there is no person query/body selector. Writes require the existing same-origin check and session CSRF.
- IDs follow the Fleet `nav.favorites` string rules: 1–128 characters, no control characters, no duplicates, at most 50.
  They are presentation references, not permission or membership. Existing list visibility still decides which are drawn.
- The browser reads first, then imports its legacy `agend_hub_favorites.<login>` list with `onlyIfUnset: true` only when
  the row is absent. The insert/update is atomic; simultaneous browsers cannot overwrite the first import. An initialized
  empty list remains empty. The local source remains exported and successful reads/writes mirror into its existing key.
- Writes are serialized within the page. A newer local edit supersedes an older response. Focus and same-login storage
  events refresh the Hub list; no polling or second SSE stream is added. Session changes retire listeners/results, and a
  source's captured session CSRF must still match before the client issues any request.

## Verification

On the source above, in an owned test environment:

```sh
GOMAXPROCS=2 nice -n 10 node_modules/.bin/vitest run \
  tests/hub-person-prefs-s149.test.ts tests/hub-person-prefs-ui-s149.test.ts \
  tests/hub-room-favorites-s145.test.ts tests/hub-rooms-migration-r1.test.ts \
  tests/hub-groups-mount-s89.test.ts tests/hub-shared-modules-a.test.ts \
  tests/hub-rooms-client-3092.test.ts tests/hub-room-client-contract-r3.test.ts \
  tests/hub-s3b-flow.test.ts tests/hub-skill.test.ts --maxWorkers=2
```

Result: **85/85, 10 files**, no skipped tests. Source and test `tsc --noEmit` each exit 0. Changelog check: 482 fragments
OK; `git diff --check` clean. Earlier 22- and 69-test runs are subsets, not additional distinct coverage.

The DB migration test upgrades an existing on-disk SQLite database and reopens it. HTTP tests use the actual Hub
composition, sessions and SQLite with an inert directory and owned loopback HTTP socket. UI tests use the existing app
DOM harness and real Hub web client against controlled fetch transports, including held reads/writes. The sidebar test
exercises the actual session hook and row menu. This is not a browser screenshot, live directory/Fleet or release run.

Four isolated reversals were each applied once, failed with assertion errors, and restored:

| ID | Reversal | Assertion |
| --- | --- | --- |
| I1 | Let initialization overwrite an existing row | Concurrent migration / initialized-empty test |
| I2 | Accept duplicate IDs | Validation leaves saved list unchanged |
| I3 | Skip preference-write CSRF | Own-session CSRF test |
| I4 | Ignore the captured session token | Retired client cannot issue an old source's write |

`reversals.json` records exact base/replacement/test-input SHA-256 values. `bindings.json` binds all changed source,
tests, skill and change notes. Raw local run logs are not committed; no independent reviewer execution is claimed.

## Limits and rollback

Concurrent devices use whole-list last-write-wins, like the existing favourite setting; refresh on returning to the tab
shows the latest server state. A failed save remains pending in the current page and retries on focus or the next edit;
closing that page can lose that unsaved edit. Cross-device updates are not pushed while an unfocused tab remains open.

Rollback can restore the local-only UI while retaining this additive table and migration registration. Do not drop
personal rows or delete migration metadata. Running a pre-migration binary against the upgraded DB is refused by the
existing migration registry; a full binary downgrade requires the normal pre-update database backup.
