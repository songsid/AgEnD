# Hub room-creation role

A custom role can grant `rooms.create` to people or eligible AD groups at Hub scope. The existing configured administrator, selected people and creator teams remain independent ways to create a room. Existing room managers retain their management and picker access when a creation grant is removed.

The built-in roles keep their existing 10/5/3 permission defaults and stored policy images. Conversion and migration grant nothing. Room creation alone does not expose Hub administration. The role editor labels this member-level permission in English and zh-TW, and permits AD-group recipients. Administration explains that role grants and the creator list are independent, including when either grant is removed.

## Governing scope

The accepted room-role scope is: “Add a rooms.create permission custom roles can grant; the allowlist keeps working.” Its compatibility acceptance is: “Existing allowlist/teams behave exactly as before; migration adds nothing.”

The original [D1–D7 role design](https://github.com/songsid/AgEnD/blob/c67210c44/docs/design/hub-roles-permissions.md) limits D2 to Hub-management permissions: “roles with Hub-management permissions go to persons only, never AD groups.” Its D2 table allows member/self-use and team roles to be assigned to AD groups. Room creation was not in the original twelve-permission catalogue and is a member capability, outside those five management permissions. The first administrator keeps the existing creator path; other Administrator-role holders do not acquire a new creation grant implicitly.

## Verification

- At the original base `f9532de65c8fae8dfbf2ed262c287ddc9796eb34`, the new positive control fails: a creation role projects `canCreateRooms: false`.
- The corrected group/authority and compatibility runs passed 117 tests in seven files, 66 in six files, and 61 in the final four UI/room files. These overlap; they are not one aggregate invocation. The room control file now has 25 passing cases. The hint-cache/UI run passes 61 tests in three files; the four shared-search suites pass 42, with overlap with earlier evidence.
- Controls cover person and eligible AD-group grants, membership removal, group-read policy revocation, unknown/stale/future/wrong-person facts, assignment mode/time, legacy people/teams, proof expiry, reentrant rollback, existing managers, no migration grants, no administration exposure and explicit AD-group UI selection.
- Room-list capability is presentation only: provider errors or expired proofs give `canCreateRooms: false` while rooms remain readable. New creation and candidate operations retain their own strict proofs. Only a boolean hint is cached for up to 60 seconds per actor, session and app, with provider binding, wall/monotonic expiry, a 256-entry bound and shared in-flight lookups. Original per-request authentication stays fresh. Create/candidates/groupSelection never use the hint cache. A newly granted or revoked permission can take until a hint refresh to change the button; writes recheck immediately. An issuer with no potentially granting assignment refuses before an extra role-directory read.
- A two-case mutant making the room list propagate provider/proof failures is red; restoring the implementation passes both cases. The earlier revoked-proof mutant remains evidence for the unchanged strict room-write checkpoint; its target-specific post-permit barrier was checked before recording the result.
- The list-load regression fails on the previous implementation: two AD-membership reads for the same session at a 30-second interval, expected one. The fixed control passes; tests also cover concurrent coalescing, TTL refresh, session/actor isolation and strict refusal despite a stale positive hint.
- Final source and test typechecks, changelog validation and public-text checks pass. Exact-head CI and reviewer findings are tracked on the PR.
- The actual prior release role parser is retained as a fixture (only imports adapted). It accepts unchanged built-ins and rejects a policy containing the new permission; the current parser accepts it. This is a reader test, not an older-Hub startup or downgrade campaign.

## Real-app views

`browser-report.json` retains the eight previously cleared permission/creator frames at `7a9d2b3e9c0d39eca41994861aa75269ef27ee53` (26 primary checks). Relevant UI bindings for those views remain byte-identical. Their runtime predates the display-hint cache; the strict create/candidate method bodies are still byte-identical, as bound in the manifest. The original actual HTTP AD-group grant/create/membership-removal/existing-manager proof carries with that historical scope.

Twelve current frames at `b522c0e4b2d06b6575877054ce41732463ad9705` come from four selected-case runs, each 15 positive checks/three frames. These overlap and are not 60 distinct cases. They show the main assignment action, a populated settled drawer with an enabled primary, and the native recipient dropdown open with both options. The harness waits for actual animations to finish and records opacity 1/transform none, primary enabled/visible, `select:open` and exact positive capture count. No production motion/timing is changed. A fixture group is selected without submitting another assignment.

Every current or retained original has been individually inspected. Current frames localize the admin-entered fixture description per language; the earlier role-card English description is stored admin content, not untranslated UI copy. Desktop is 1366×1000, phone 390×844, English and zh-TW, dark theme. In the phone EN people frame a navigation tab is partly outside its horizontal viewport; target assignment controls fit. An open native menu temporarily covers text shown in its settled companion. The retained phone secondary room table shows partial columns. No full table visibility, native mobile, light-theme, real AD, load or deployed-pilot claim.

| View | Main action | Settled drawer | Open recipients | Retained permission | Retained creator list |
| --- | --- | --- | --- | --- | --- |
| Desktop, English | [Original](desk-dark-en-people.png) | [Original](desk-dark-en-assign.png) | [Original](desk-dark-en-assign-open.png) | [Original](desk-dark-en-role.png) | [Original](desk-dark-en-creators.png) |
| Desktop, zh-TW | [Original](desk-dark-zh-TW-people.png) | [Original](desk-dark-zh-TW-assign.png) | [Original](desk-dark-zh-TW-assign-open.png) | [Original](desk-dark-zh-TW-role.png) | [Original](desk-dark-zh-TW-creators.png) |
| Phone, English | [Original](phone-dark-en-people.png) | [Original](phone-dark-en-assign.png) | [Original](phone-dark-en-assign-open.png) | [Original](phone-dark-en-role.png) | [Original](phone-dark-en-creators.png) |
| Phone, zh-TW | [Original](phone-dark-zh-TW-people.png) | [Original](phone-dark-zh-TW-assign.png) | [Original](phone-dark-zh-TW-assign-open.png) | [Original](phone-dark-zh-TW-role.png) | [Original](phone-dark-zh-TW-creators.png) |

Reproduce with the committed `scripts/manual/hub-room-create-role-s256/browser.mts`, `OUT` set to a disposable directory, `PW_DIR` pointing to a local Playwright installation and optional `CHROMIUM` selecting an installed Chromium executable. No live credentials are needed. The temporary Hub is closed and its owned home/certificates removed in `finally`.

## List refresh and directory load

`panel-hub.js:396–447` reads on initial/session load and polls every 30 seconds while visible; return/focus refreshes are debounced to 5 seconds. Explicit create/leave/send and waiting-status actions also refresh. `refreshRooms` coalesces an active network read. The global room subscription updates unread state locally; it does not refetch on every `room.changed`. New-room and settings forms read the list on mount for assistant metadata when it is not supplied. The new 60-second cache prevents each of these reads from repeating creation-specific eligibility and AD-group lookups; it does not remove the existing authentication eligibility read.

## Boundaries and rollback

No schema migration or creator-list rewrite is introduced. D2 management assignments remain person-only and Hub-wide. Room-creation roles can be assigned to people or eligible AD groups; existing creator teams keep their original list behavior. Role-only operations keep the existing five-second effect-proof lifetime and refuse expired or changed proofs rather than silently refreshing them. This does not implement members adding their agents to rooms.

An older binary cannot parse a policy that contains `rooms.create`; role-policy operations fail closed rather than treating it as a legacy policy or granting access. This PR does not add transparent policy downgrade support. A blind code rollback after the grant has been stored is unsafe operationally. Use a compatible version to remove the permission from **every role** before attempting a downgrade (removing assignments alone is insufficient), then validate the policy against the target reader. Full older-runtime and historical-audit compatibility are not claimed by the reader test. Existing rooms, memberships and creator-list data must not be deleted or rewritten.
