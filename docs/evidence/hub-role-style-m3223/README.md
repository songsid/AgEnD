## Scope and source binding

Argon's M-3223 styling pass for the prepared role settings page. Activation PR #4056 stays on USER HOLD. This alpha PR changes role presentation and its focused interaction tests only; it does not mount role administration or activate roles.

The original page used nested headings and unconstrained controls instead of the shared Hub layout. It now reuses Hub rows/actions, PeopleSearch and GroupSearch, chips, the compact Fleet limit input, metric tiles and the responsive team table. The editor groups its 12 permissions into 3 self-use, 4 team and 5 Hub administration permissions. Existing locked/forthcoming bits and person-only management assignments remain enforced. A selected subject hides the search; Change restores it. Previews appear immediately after their initiating form/card. Phone Edit/Remove actions stay together.

The already-reviewed display-name, proposed-change and translated-audit helpers from the held activation UI are carried here so styling can land first. No activation/server changes are copied. Group selections retain the original returned realm/key through GroupSearch normalization; only the existing role-search API is used.

`binding.json` records source and blob identities. Both screenshot runs initialize an actual production Hub runtime over HTTPS/SQLite, with synthetic AD identities and credentials, in separate owned temporary homes. Before is the reviewed held activation tree; after is the same tree with exactly the three role presentation files replaced by their committed styling blobs. All Hub/server code is byte-identical. No live Fleet, vendor CLI or real directory/account is used. Both runtimes are drained and temporary homes removed.

## Captures

Each before/after directory covers desktop 1440×1000 and phone 390×844, English and zh-TW, light and dark. Each combination contains overview, editor, assignment selection, checked preview, saved assignment and audit views. Tall sections use numbered **actual scrolling viewport frames**, not stitched pictures or CSS overrides. The next frame continues lower in the same section.

The before run passes 59 checks with 80 frames; after passes 99 checks with 71 frames. After checks include phone control/checkbox-label touch targets, horizontal overflow, all 12 permissions, paired action alignment, actual HTTP assignment persistence and no browser exceptions. Fewer after frames reflect the compact layout. Both run headless inside WSL. The initial capture adapter expected the old exact Choose accessible name; it was corrected for the shared picker's descriptive name. Tall-panel element captures were replaced with scrolling viewport captures during image review; final receipts and files are the corrected packet.

Start with:

- [zh-TW desktop editor before](before/before-desk-light-zh-TW-editor.png) / [after](after/after-desk-light-zh-TW-editor.png).
- [zh-TW phone editor before](before/before-phone-light-zh-TW-editor.png) / [after](after/after-phone-light-zh-TW-editor.png), continuing in [after frame 2](after/after-phone-light-zh-TW-editor-2.png).
- [English dark assignment before](before/before-phone-dark-en-assignment.png) / [after](after/after-phone-dark-en-assignment.png).
- [English dark audit before](before/before-phone-dark-en-audit.png) / [after](after/after-phone-dark-en-audit.png), continuing through numbered audit frames.

Scoped read-only image inspection confirmed the corrected phone identity wrapping, scoped availability badges, no Delete action on an unsaved role, all 12 permissions, and readable dark audit rows. Exact inspected files are in `binding.json`.

## Validation and rollback

- `npx vitest run tests/hub-role-ui-3223.test.ts --maxWorkers=2`: **15/15**. Covers grouped controls, person-only assignments, checked-save/digest preservation, stale sign-out, shared person/group selection, original group keys, localized summaries and unknown audit actors.
- `npm run typecheck:tests`: **0**.
- `git diff --check`: clean.
- Reproduction: `REPO=<before-or-after-integration-tree> MODE=before|after OUT=<owned-output> node node_modules/tsx/dist/cli.mjs scripts/manual/hub-role-style-m3223/browser.mts`.

Risk is confined to role-page layout/selection presentation; the inactive page still awaits activation approval. Rollback is a normal revert of the styling PR, with no migration or data changes. Later activation must preserve these UI blobs while retaining its independently reviewed authority fix.
