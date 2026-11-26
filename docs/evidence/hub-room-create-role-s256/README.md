# Hub room-creation role

A custom role can grant `rooms.create` to people or eligible AD groups at Hub scope. The existing configured administrator, selected people and creator teams remain independent ways to create a room. Existing room managers retain their management and picker access when a creation grant is removed.

The built-in roles keep their existing 10/5/3 permission defaults and stored policy images. Conversion and migration grant nothing. Room creation alone does not expose Hub administration. The role editor labels this member-level permission in English and zh-TW, and permits AD-group recipients. Administration explains that role grants and the creator list are independent, including when either grant is removed.

## Governing scope

The accepted room-role scope is: “Add a rooms.create permission custom roles can grant; the allowlist keeps working.” Its compatibility acceptance is: “Existing allowlist/teams behave exactly as before; migration adds nothing.”

The original [D1–D7 role design](https://github.com/songsid/AgEnD/blob/c67210c44/docs/design/hub-roles-permissions.md) limits D2 to Hub-management permissions: “roles with Hub-management permissions go to persons only, never AD groups.” Its D2 table allows member/self-use and team roles to be assigned to AD groups. Room creation was not in the original twelve-permission catalogue and is a member capability, outside those five management permissions. The first administrator keeps the existing creator path; other Administrator-role holders do not acquire a new creation grant implicitly.

## Verification

- At the original base `f9532de65c8fae8dfbf2ed262c287ddc9796eb34`, the new positive control fails: a creation role projects `canCreateRooms: false`.
- The corrected group/authority and compatibility runs passed 117 tests in seven files, 66 in six files, and 61 in the final four UI/room files. These overlap; they are not one aggregate invocation. The room control file has 22 passing cases.
- Controls cover person and eligible AD-group grants, membership removal, group-read policy revocation, unknown/stale/future/wrong-person facts, assignment mode/time, legacy people/teams, proof expiry, reentrant rollback, existing managers, no migration grants, no administration exposure and explicit AD-group UI selection.
- Room-list capability is presentation only: provider errors or expired proofs give `canCreateRooms: false` while rooms remain readable. New creation and candidate operations retain their own strict proofs. No cache is introduced; an issuer with no potentially granting assignment refuses before an extra role-directory read.
- A two-case mutant making the room list propagate provider/proof failures is red; restoring the implementation passes both cases. The earlier revoked-proof mutant remains evidence for the unchanged strict room-write checkpoint; its target-specific post-permit barrier was checked before recording the result.
- Final source and test typechecks, changelog validation and public-text checks pass. Exact-head CI and reviewer findings are tracked on the PR.
- The actual prior release role parser is retained as a fixture (only imports adapted). It accepts unchanged built-ins and rejects a policy containing the new permission; the current parser accepts it. This is a reader test, not an older-Hub startup or downgrade campaign.

## Real-app views

`browser-report.json` binds two clean-source runs. The primary run at `7a9d2b3e9c0d39eca41994861aa75269ef27ee53` has 26 positive checks and eight changed role/creator views. The supplemental run captures four AD-recipient drawers; its only source difference is the targeted harness. Every production SHA-256 binding is identical between the two runs. Their checks overlap.

The initialized production Hub uses HTTPS, SQLite and inert synthetic directory identities. Actual HTTP preview/apply saves an AD-group role assignment. A member creates a room; removing their fresh AD membership blocks new creation while their existing manager access remains. No Fleet or provider runs.

Twelve originals cover desktop 1366 × 1000 and phone 390 × 844, English and zh-TW, dark theme. Every original was individually checked for readability and fixture-only content. Relevant sections are scrolled into view; unrelated header/footer content can be outside the viewport. In the phone creator views, later columns of the secondary All rooms table are outside the shown area; the creator explanation/input are fully visible. These images do not establish full table visibility or scrolling behavior. The phone is Chromium emulation, not native mobile. The recipient drawers show AD-group mode with an empty search; submitting a group is established separately by the real HTTP flow and mounted UI control. No light-theme, real AD, load or deployed-pilot claim.

| View | Role permission | AD-group recipients | Who can create |
| --- | --- | --- | --- |
| Desktop, English | [Original](desk-dark-en-role.png) | [Original](desk-dark-en-assign.png) | [Original](desk-dark-en-creators.png) |
| Desktop, zh-TW | [Original](desk-dark-zh-TW-role.png) | [Original](desk-dark-zh-TW-assign.png) | [Original](desk-dark-zh-TW-creators.png) |
| Phone, English | [Original](phone-dark-en-role.png) | [Original](phone-dark-en-assign.png) | [Original](phone-dark-en-creators.png) |
| Phone, zh-TW | [Original](phone-dark-zh-TW-role.png) | [Original](phone-dark-zh-TW-assign.png) | [Original](phone-dark-zh-TW-creators.png) |

Reproduce with the committed `scripts/manual/hub-room-create-role-s256/browser.mts`, `OUT` set to a disposable directory, `PW_DIR` pointing to a local Playwright installation and optional `CHROMIUM` selecting an installed Chromium executable. No live credentials are needed. The temporary Hub is closed and its owned home/certificates removed in `finally`.

## Boundaries and rollback

No schema migration or creator-list rewrite is introduced. D2 management assignments remain person-only and Hub-wide. Room-creation roles can be assigned to people or eligible AD groups; existing creator teams keep their original list behavior. Role-only operations keep the existing five-second effect-proof lifetime and refuse expired or changed proofs rather than silently refreshing them. This does not implement members adding their agents to rooms.

An older binary cannot parse a policy that contains `rooms.create`; role-policy operations fail closed rather than treating it as a legacy policy or granting access. This PR does not add transparent policy downgrade support. A blind code rollback after the grant has been stored is unsafe operationally. Use a compatible version to remove the permission from **every role** before attempting a downgrade (removing assignments alone is insufficient), then validate the policy against the target reader. Full older-runtime and historical-audit compatibility are not claimed by the reader test. Existing rooms, memberships and creator-list data must not be deleted or rewritten.
