## Approved reference pattern

M-3223/S-168 follows Lumen's Google Workspace Admin roles recommendation (`reference-pattern.md`, supplied by the Leader), not a claim of pixel identity with a live Google console. Official reference: [Create, edit and delete custom admin roles](https://knowledge.workspace.google.com/admin/users/create-edit-and-delete-custom-admin-roles).

The stacked role cards are replaced by **Roles / People / Audit log**. Roles have purpose sentences, assigned counts and one Assign action. Each role opens People/Permissions. Creation/editing has Info → Permissions → Review and Start from an existing role. Nine selectable permissions have verified descriptions; Administrator's reserved permission is read-only, and the two unavailable approvals have no checkboxes. Assigning uses the shared focus-trapping Dialog drawer with batch selection, applicable scope and optional dates/limit. Review names changes and known people losing permissions; a zero result is one sentence, with uncertainty separated. Audit has named historical old/new details, filters and action-only CSV export. Status moves to Roles settings; migration notices use the existing Notices destination.

The original seven UI test cases were adapted to these new flows while retaining their checked-policy/digest, empty quota, person-only management, dedicated root operation, sign-out fence and assignment-stamp controls. Added cases cover templates, batch people/groups, original group identity, named non-zero impact, old-client filter/export refusal, renamed built-ins, localized own-access labels, correct save/last-admin errors, disclosure cues, keyboard tabs and limited-role visibility.

No production activation is included. **#4056 stays USER HOLD pending the user's approval. #4063 is superseded.** Data/continuity preparation #4068 is merged separately.

## Real-Hub source and fixtures

`binding.json` records source commits and subtree identities. Actual initialized production Hub runtimes serve HTTPS/UI against SQLite in owned temporary homes, with synthetic AD people/groups and credentials. The after fixture composes this UI with the reviewed held #4056 activation solely inside the disposable rig. `capture-activation.patch` records that source-only composition; no live Fleet, real directory, vendor CLI or account is used.

The before fixture uses the exact three reviewed #4063 role presentation blobs, with the same current server and surrounding Hub shell. It therefore shows the actual prior stacked role component, not a mockup or a different server. The entire `src/hub` subtree is byte/mode-identical before and after. The after helper changed during the focused visual fix; it is unused by the before component.

Fixture setup uses actual authenticated HTTP checked writes to create a described Support leads role, assign Alex, apply the first administrator's own-access defaults and record a description change. Removing that role's `audit.view` yields a genuine non-zero fact-bound impact naming Alex. Assignment captures select Jo and a Product AD-group scope. Audit captures open a historical record; the initial desktop English run also downloads and inspects an actual metadata-only CSV.

All captures run **headless inside WSL**. Both runtimes and temporary homes are drained/removed.

## Captures to start with

Desktop English light:

- [Roles before](before/before-desk-light-en-roles.png) / [after](after/after-desk-light-en-roles.png).
- [Permissions before](before/before-desk-light-en-permissions.png) / [after](after/after-desk-light-en-permissions.png).
- [Create step before](before/before-desk-light-en-create.png) / [after](after/after-desk-light-en-create.png).
- [Assignment before](before/before-desk-light-en-assign.png) / [after](after/after-desk-light-en-assign.png).
- [Non-zero review before](before/before-desk-light-en-review.png) / [after](after/after-desk-light-en-review.png).
- [Audit before](before/before-desk-light-en-audit.png) / [after](after/after-desk-light-en-audit.png).

Phone zh-TW dark:

- [Roles](after/after-phone-dark-zh-TW-roles.png), [permissions](after/after-phone-dark-zh-TW-permissions.png), [create](after/after-phone-dark-zh-TW-create.png), [assign](after/after-phone-dark-zh-TW-assign.png), [named review](after/after-phone-dark-zh-TW-review.png), [audit](after/after-phone-dark-zh-TW-audit.png).

Both directories contain **desktop/phone × EN/zh-TW × light/dark**, all six views. Numbered files are subsequent **real scrolling viewport frames**, not stitched images or CSS overrides. They show starts/continuations (up to four per tall view, two for audit), not the entire historical audit. The new phone read page intentionally starts with only Using the Hub expanded; visible carets disclose the other sections.

## Checks and scoped fixes

- Initial complete after run: **101 checks, 84 frames**, including all eight combinations, nine choosable permissions, real named loss, overflow/panel bounds, CSV and no browser exceptions.
- Image inspection found a missing mobile expansion cue and a misleading zh-TW recipient label. R1 adds carets, uses 指派對象, and clears searches after selecting a recipient. Only permissions/create/assignment views were retaken: **48 checks, 44 replacement frames**. Audit/CSV were not repeated. `after/receipt.json` combines unchanged original views with those replacements, each tagged with its actual source head; all published file hashes match.
- Before comparison: **52 checks, 92 frames**, no browser exceptions. An initial strict selector matched both old lists before taking any frame; the harness was narrowed to its first visible list.
- Final read-only image inspection confirms the prior stacked layout, new navigation/purposes/counts, nine descriptive choices, corrected mobile cues/recipient, named Alex loss and readable expanded audit. No remaining obvious visible defect in the inspected frames.
- Later keyboard/limited-role fallback and complete audit action-filter option patches change no captured administrator layout. It was checked with focused interaction tests, without repeating the matrix.

Focused verification: final role UI **20/20**; display/CSV helpers **4/4**; module inventory **11/11**. Shell/pairing/directory/client batch **64/64**, then the added Notices route case in the shell file **13/13**. These overlap; they are not summed. Source/test typechecks passed. The alpha merge left the owned UI components/tests unchanged; no local re-verification was run solely for that sync.

## Permission copy and rollback

Lumen confirmed the source audit corrections: joining means Fleet invitations/join codes **not the allowed list**; disconnect really revokes a Fleet connection, while recommended versions require Administrator. Team roster/usage choices say “Takes effect when team views open”; the Manager purpose qualifies that future effect. Root own-access is localized by its reserved identity. Built-in renames are respected. Failed saves use save wording, and the last-administrator refusal has its own message.

Risk is confined to the new role UI, its existing client block and Notices composition; all writes still use the one checked server proposal. CSV is metadata-only and requires filtered history to fit 5,000 rows. A retained old client is told to refresh before filters/export can be used. Revert this UI slice for rollback; no activation or migration is added. Preserve the separate data/schema forward-rollback requirements from #4068 and the authority fix in held #4056 when they are composed later.
