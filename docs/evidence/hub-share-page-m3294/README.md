# Grouped My agents page

An owner can now share agents from one Hub page: tick changes in a Fleet group, apply once, and choose who may ask.
Previously the page listed only shared agents and sent the owner to Fleet Settings. The implementation uses the
existing durable member sharing writer and notices, with no second Fleet confirmation.

The page separates an admitted request, a Fleet result and an accepted publication. Only accepted exposure rows count
as shared. A dropped response followed by reload and Refresh sends the same frozen request body and UUID. Partial
refusals remain per row. General is explicit and Select all skips it; ClassicBot rooms remain eligible with their
one-memory explanation. Offline and older Fleet rows explain their limits, while existing shares retain their detail
and pause controls. Personal agents have their own section and controls.

A new share grants nobody automatically. The existing access picker can apply a selected person, group or team to
several independently checked targets, or choose each separately. Exact-login composition remains available without
subject search. Explicit previous-list selection is owner/session/Fleet-generation/revision/digest-bound and preserves
original expiry. Retrying selection cannot revive a subsequently revoked grant. This path never calls Undo or reopens
old chat history.

Validation:

- The old owner renderer fails the grouped-page assertion; the original HTTP composition fails both new endpoint tests.
- Affected suites: 185 tests in 14 files. Final additional owner/app, personal separation and exact-login/sign-out pins
  pass 10 tests in two overlapping files. These counts are staged and are not added together.
- Removing the kept Fleet-generation check or selected digest check causes a semantic assertion failure; exact source
  is restored. Removing only the exposure-owner check is equivalent because Fleet/kept owner guards independently deny it.
- Source and test TypeScript have no diagnostics at the recorded stage.
- Actual scratch Hub HTTPS, HTTP/session/CSRF, SQLite and real audit, plus the real local sharing journal/writer:
  17 journey checks. A response is deliberately dropped, the page reloads, exact replay is observed, both agents publish,
  and one selected recipient is saved to both target revisions. Member transport and company directory are in-process fixtures.
- Headless Linux desktop EN and phone zh-TW. The focused font/scroll retake passes 12 checks and confirms that the
  ClassicBot disclosure scrolls fully above the action bar. No Windows or headed browser was opened.
- Landed agent-introduction changes are plain-merged. Five overlapping files preserve both features; 24 own blobs/modes
  stay identical. Conflict-focused suites pass 46 tests in six files; no unchanged browser journey was repeated.

Original-stage images (historical after the UX revision below): both `before/*`; both `after/*-groups.png`, `after/*-draft.png` and `after/*-stop-confirm.png`;
`after/desk-light-en-access.png` records the successful multi-agent access step. Phone before/after originals use an
owned Noto CJK font. The initial fixture lacked that font and those unreadable phone images are excluded. An earlier
fault-injection fetch did not inherit Chromium's DNS override, and the first search fixture omitted its granting-directory
adapter; these harness issues were corrected before the successful journey. Raw credential-bearing debug logs remain
private and are not included. Every owned temporary browser home, key and listener is closed or removed.

Rollback: revert this page slice. Existing shares, grants, Settings confirmations and the earlier notice/Undo implementation
continue through their existing controls. No schema migration is introduced by this slice.


## UX revision: current preferred views

Use the eight originals in **pm-r1/**: desktop EN and phone zh-TW, each with groups, draft, stop confirmation and
multi-agent access. All nine feedback points are addressed in one batch. The invitation error was a fixture omission:
the production server already mounts `createHubRoomInvitations` and its migration; the rig now does too. Modern
fixture Fleets report their version, and the page's update notice counts only connected Fleets lacking the catalog or
request ability. It does not label an otherwise capable Fleet old because its general version is unknown.

The Fleet summary is one line with Connect instead of a duplicate roster. There is one lead under the title. Avatars
reuse the existing identity-tone classes. Offline information is a short header, repeated row reasons are removed,
and older Fleets show only the known shared count. Common access is primary and names are plain list items. Phone
Pause occupies a row beneath status; the bar names affected agents instead of duplicating its button.

Two new regression assertions fail on the original UI. The focused final suites pass **87/6**; test TypeScript has no
diagnostics. The first phone geometry check caught a more-specific shared flex rule overriding the grid. Increasing
the scoped selector fixes that real layout defect; before/after geometry is retained. The final headless real-page
retake passes **27/27**, with no invitation error, readable avatars, one lead, the correct update count, a plain access
list and Pause below status. It is a focused retake; the earlier lost-response/backend journey is not rerun.

Non-UI Hub source, the sharing writer and previous-access service are byte-identical to the reviewed head. Retained
team/group grants remain inert if their subjects stop resolving: each ask uses `prepareGrantAccess`, which reads
current team membership and fenced directory group facts. Missing readers or disabled group support are unavailable;
only matching current membership allows an action. The proof rechecks the selected grant row and membership image.
This is the same ongoing subject check used by ordinary grants and the earlier Undo path.
