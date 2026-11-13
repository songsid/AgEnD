# Room directory acceptance

Source `4097a9a633062a531e638a6e1e0590a2bf54a42b` over #3864 `5b71d3f4d0d2496278fb90f26f326ebabf19c8ed`. This is an ordinary pilot feature slice, still draft/parent-held. The receipt binds source, tests, design, changelog and the updated Hub skill.

Initial unseen-person and group-suggestion assertions failed before implementation. The held-read test initially timed out because the missing picker never entered its directory stub; that is not counted as a semantic assertion-red. Current controls cover fresh bounded suggestions, no side effects from search, pre-sign-in selection and first real sign-in discovery, group counts and deduplicated union limits, complete/incomplete group snapshots, manager-only group/Team additions, source changes retaining membership, optional assistant add and archived detail with a refusing invitation port. Pre-sign-in labels never insert hub_people or sessions, preserving the existing catalog sign-in witness.

64/64 across8 focused suites plus51/51 across4 disjoint compatibility suites. The candidate file then passes7/7 after the archive control (its original6 overlap), and administration passes6/6 after label-projection SQL. This covers116 distinct current cases across12 files, not one invocation. Both native TypeScript programs and changelog/diff checks pass. Earlier27/4 and11/2 overlap and are not added.

The directory adapter's inert peers cover multi-page direct membership, disabled accounts, escaped DN matching, strict size-limit/referral failures, changed GUID, duplicate/outside-base entries and physical close. The locked ldapts source behavior is pinned in the receipt. This is not real AD or a mounted browser walkthrough; normal production TLS checks are unchanged. No real CLI/account/Fleet/vendor request, no optional security/mutant campaign.

Lumen confirmed all direct eligible people including never-signed-in,100-person union bound, no nested groups and snapshot-only membership (aafd4ae2c). Chosen-group preview returns a count; the UI must preserve existing selections on group-unavailable and render people-limit with the returned count. signedIn:false is an additive member field; older UI can ignore it. Team SQL/search callback and concrete C/A composition remain owned by those tracks.

Rollback retains the DB/content keys/history and deploys a compatible correction. Older binaries refuse the new s3-room-directory component; never remove sign-in history to undo a display label.

## Shared UI response correction

Source `2da528a2c04dc9c856289229c0cd74fe7382dd7b` carries the actual-browser finding from the broader integration checkpoint `0529469f0466da2e2a5e0e6f2c162f9d2eb441db`. Candidate search and exposure-room reads now return the `{candidates}` and `{rooms}` envelopes consumed by the shared client. Creator-policy GET returns named people and Team head counts; PUT retains ID-only input and the existing permission boundary. Existing candidate/admin content assertions remain; a new actual-HTTP regression pins all three public shapes.

The three new assertions were red before the fix on that broader integration candidate, where the relevant pre-fix methods matched this draft. This is not claimed as an exact-draft fail-first execution. After carrying the fix here,19/19 across4 focused files and both native TypeScript programs pass. These cases overlap the historical116/12 scope above.

The integration packet separately records78/10 server checks,46/5 UI checks, and16/16 browser checks with8 original PNGs. Those are broader R/C/A/U results, not executions on this draft. NewRoom is mounted in a component harness, so the full shell/settings/invitation/Team walk remains open. Lumen reviewed the8 PNGs and requested localized system events plus U-owned glyph/composer/singular-count corrections before that full walk.

## Viewer-localized system events

Source `509b940cb371a92f56f427432170179beab860a8 adds structured creation, member-join and explicit-admin-join events after Lumen's actual-PNG pass (UX8224c4675). `message.system` carries the kind and exact display name; `lastSystem` does the same for list previews. Existing system-author storage retains these fields without a schema change. English fallback text stays for cached UI and historical unmarked rows; no sentence parsing or retrospective identity inference.

All3 new production-HTTP/SQLite regressions were semantic assertion-red before implementation on234e50c37. The restored6-file slice passes37/37, and both fresh native programs exit0. Coverage includes persistence across HTTP restart, names containing sentence-like text, person/agent/admin events, list metadata and legacy fallback. The run also caught two old R1 candidate-envelope assertions; only the new envelope access changes, retaining their full item/eligibility expectations. Counts overlap earlier DTO/historical runs. Changelog assembly checks460 fragments and whitespace is clean. U1's viewer-localized renderer and Lumen's other UI adjustments remain separately owned.
