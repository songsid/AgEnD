# Full public U2 + B2 composition — not final acceptance

Plain merge cfe1ea8eda30ad1883fd4f2bd5b3f18f0310d5c1 brings U2
c89dd65f02961b7ff7dee581e5bb4d369074c797 (#3698) into B2
5d3385fe8d43e41fe7a4a6e3c719a889d8976650. It was clean: no conflict
resolution or manual editing of U2/Fleet input files. U2 remains open at this
point; this is preparation against its public source, not a landing claim.

The actual `HubJoinCard` now mounts the actual lazy B2 component. New EN and
zh-TW tests create the first code with no allowed group, verify that the card
re-reads policy/codes and unlocks its instructions, then revoke the code and
verify that step 2/instructions close again. No substitute card or injected
code module is used. Existing tests cover the Administration entry, welcome,
Fleet labels, picker, queue and member notice opt-in.

Checks, run serially with one Vitest worker:

- 289/289 tests across 21 files, zero skips. Paths and hashes are in
  `source-binding.json`.
- Both native TypeScript source/test checks pass; 387 changelog fragments pass;
  the B2 diff against the exact public U2 head passes `git diff --check`.
- Four isolated, syntax-valid mutations fail intended assertions: page queue,
  post-sign-in queue, slot capability and code-change callback. Each restores
  exact source bytes. Removing the callback makes both new complete-card locale
  tests fail their saved-policy read assertion, plus the earlier slot test.
  The earlier 28-reversal packet remains historical; this is not a claim that
  all 28 were rerun on this composition.
- Eleven inherited U1/U2 product files, including the Fleet input, card,
  picker, welcome and Hub owner CSS, are byte-identical to U2 c89dd65f.
  The same 21 B1 product files are unchanged; B2's UI composition/local notice
  projection remain its only two changed B1 product files.

This uses production Preact/modules with inert clients/fetch and the existing
owned synthetic HTTPS/LDAPS fixture. No Chromium, container, native Windows,
real directory/account, backend CLI or pilot operation occurred. The first
zh-TW test setup incorrectly changed language after mounting a non-subscribing
component; setting it before mount fixed that fixture without a product edit.

Still required before review: U2/B1 landed-source sync, EN/zh-TW desktop/phone
real-shell PNGs, actual cached-shell/CSS SKEW, and combined B-L* acceptance.
The latter must include five distinct real Fleet UI paths and the 20/50-Fleet
capacity legs. Ask the leader for a heavy-campaign window before any such run;
do not overlap the alpha.15 rehearsal. No PR readiness, parity approval or
merge/gate claim is made here.

Rollback of this composition is its own merge commit; reverting B2's UI does
not remove B1's schema or issued credentials. Browser layout and full
orchestration remain unverified by these light checks.
