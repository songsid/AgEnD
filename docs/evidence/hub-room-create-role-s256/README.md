# Hub room-creation role

A custom role can grant `rooms.create` to a person at Hub scope. The existing configured administrator, selected people and creator teams remain independent ways to create a room. Existing room managers retain their management and picker access when a creation grant is removed.

The built-in roles keep their existing 10/5/3 permission defaults and stored policy images. Conversion and migration grant nothing. Room creation alone does not expose Hub administration. The role editor labels this permission in English and zh-TW; Administration explains that role grants and the creator list are independent.

## Verification

- The base at `f9532de65c8fae8dfbf2ed262c287ddc9796eb34` fails the new positive control: a room-creation role still projects `canCreateRooms: false`.
- Twelve related test files passed across scoped runs. Counts overlap and are not a single combined invocation. The last four-file control run passed 46 tests; the final two target-specific post-permit directory/expiry controls passed 2/2.
- The deliberate mutant removing `role.assertCurrent()` fails the held-directory regression: it creates a room after its role was revoked. Restoring the production file passes. The barrier holds selection of another person after the role proof, rather than holding initial authentication.
- Controls cover grant/revocation, role mode and assignment timing, different people, legacy people/teams while the role service is unavailable, expired proof, reentrant audit-time revocation and rollback, existing room management, unchanged built-in defaults/conversion, role-loss review and administration visibility.
- Source and test typechecks passed; changelog validation and the public-text checker passed. Exact-head CI and reviewer findings are tracked on the PR.

## Real-app views

`browser-report.json` binds the captures to clean source `52b1932f2ce55d71592d1a2189643427d3ba1514`, source SHA-256 values, actual Chromium version and 19 positive checks. The capture starts an initialized production Hub runtime with HTTPS, SQLite and inert synthetic directory identities, then saves a custom role and assignment through the actual HTTP preview/apply routes. It runs no Fleet or provider.

Eight originals show the role permission and Administration creator explanation at desktop 1366 × 1000 and phone 390 × 844, in English and zh-TW, dark theme. Every original was individually inspected for readability and fixture-only content. Each relevant section is scrolled into view; unrelated header/footer content may be outside the viewport. The phone is Chromium emulation. These are not light-theme, native mobile, real AD, load or deployed-pilot results.

| View | Role permission | Who can create |
| --- | --- | --- |
| Desktop, English | [Original](desk-dark-en-role.png) | [Original](desk-dark-en-creators.png) |
| Desktop, zh-TW | [Original](desk-dark-zh-TW-role.png) | [Original](desk-dark-zh-TW-creators.png) |
| Phone, English | [Original](phone-dark-en-role.png) | [Original](phone-dark-en-creators.png) |
| Phone, zh-TW | [Original](phone-dark-zh-TW-role.png) | [Original](phone-dark-zh-TW-creators.png) |

Reproduce with the committed `scripts/manual/hub-room-create-role-s256/browser.mts`, `OUT` set to a disposable directory, `PW_DIR` pointing to a local Playwright installation and optional `CHROMIUM` selecting an installed Chromium executable. No live credentials are needed. The temporary Hub is closed and its owned home/certificates removed in `finally`.

## Boundaries and rollback

No schema migration or creator-list rewrite is introduced. Management-style role assignments remain person-only and Hub-wide; existing creator teams still work through their original list. Role-only operations keep the existing five-second effect-proof lifetime and refuse expired or changed proofs rather than silently refreshing them. This does not implement members adding their agents to rooms.

Rollback the feature commits to restore the old gate. Remove new role permissions through the checked role editor before running an older binary that cannot parse the new catalogue entry. Existing rooms, memberships and creator-list data should not be deleted or rewritten.
