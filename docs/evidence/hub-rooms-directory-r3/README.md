# Room directory acceptance

Source `4097a9a633062a531e638a6e1e0590a2bf54a42b` over #3864 `5b71d3f4d0d2496278fb90f26f326ebabf19c8ed`. This is an ordinary pilot feature slice, still draft/parent-held. The receipt binds source, tests, design, changelog and the updated Hub skill.

Initial unseen-person and group-suggestion assertions failed before implementation. The held-read test initially timed out because the missing picker never entered its directory stub; that is not counted as a semantic assertion-red. Current controls cover fresh bounded suggestions, no side effects from search, pre-sign-in selection and first real sign-in discovery, group counts and deduplicated union limits, complete/incomplete group snapshots, manager-only group/Team additions, source changes retaining membership, optional assistant add and archived detail with a refusing invitation port. Pre-sign-in labels never insert hub_people or sessions, preserving the existing catalog sign-in witness.

64/64 across8 focused suites plus51/51 across4 disjoint compatibility suites. The candidate file then passes7/7 after the archive control (its original6 overlap), and administration passes6/6 after label-projection SQL. This covers116 distinct current cases across12 files, not one invocation. Both native TypeScript programs and changelog/diff checks pass. Earlier27/4 and11/2 overlap and are not added.

The directory adapter's inert peers cover multi-page direct membership, disabled accounts, escaped DN matching, strict size-limit/referral failures, changed GUID, duplicate/outside-base entries and physical close. The locked ldapts source behavior is pinned in the receipt. This is not real AD or a mounted browser walkthrough; normal production TLS checks are unchanged. No real CLI/account/Fleet/vendor request, no optional security/mutant campaign.

Lumen confirmed all direct eligible people including never-signed-in,100-person union bound, no nested groups and snapshot-only membership (aafd4ae2c). Chosen-group preview returns a count; the UI must preserve existing selections on group-unavailable and render people-limit with the returned count. signedIn:false is an additive member field; older UI can ignore it. Team SQL/search callback and concrete C/A composition remain owned by those tracks.

Rollback retains the DB/content keys/history and deploys a compatible correction. Older binaries refuse the new s3-room-directory component; never remove sign-in history to undo a display label.
