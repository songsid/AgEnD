Code-only pairing never creates company-join's optional display cache. The paired API returned `hub.name:null`,

> **Screenshot privacy refresh (M-3513, 2026-11-22):** 6 affected paths recaptured, 0 historical dialog details cropped, 0 unreproduced pictures withdrawn. Current rendering only; prior source/test receipts remain historical. Static captures do not establish offscreen reachability or provider/native operation. Baseline/candidate denote synthetic DTO phases on the current UI, as in the original test; they are not historical asset replay. Consent/updater apply is stubbed to throw. See [privacy-refresh-m3513.json](privacy-refresh-m3513.json) for each disposition/source/hash. No live provider, CLI, pane or Fleet was used.
and the member update/recommendation producers captured the web hostname. As a result the Fleet's connection card,
update-consent explanation/dialog, owner request notice and recommended-update banner used an address.

The actual Hub factory now supplies validated `settings.name` to an optional, exact member-listener
`GET /hub/v1/display-name`. The response contains only the bounded name; the existing machine/current guards apply.
A member learns it asynchronously after ready over the current pinned member origin, including relocation.
The read has a two-second deadline and 4096-byte ceiling; no bearer, redirects, web-listener TLS fallback or new
hello/frame/capability. The optional private v1 cache is bound to Hub/issuer/Fleet/owner and is outside the profile.
A changed link/profile or teardown aborts or discards the lookup. Old 404, invalid response or cache failure cannot
hold startup, reconciliation or update eligibility. Company-join's existing display record and then the old address
fallback remain available. Blank names retain the existing unknown-name behavior; Unicode is preserved.

The pairing projection and future update notices read the learned name. Already verified recommendation DTOs
re-project the current name without a new policy lookup or ACK. Already-recorded owner notices retain their recorded
text; this change does not rewrite notice history. The first immediate notification can still use the fallback if
it arrives before the optional name lookup completes. Pairing identity, credentials, origins, current authorization,
update policy/consent, version reports and capability lists are unchanged. The built-in Hub skill and both change
fragments document the visible behavior.

Validation is bound by manifest.json to source `738034d0920de1863183fbe3d50a9a0f060be926`:

- Fail-first: the new known-display API test fails at the original projection with `name:null` instead of `Rig Hub`
  (`before-cached-name.log`, one assertion failure, 30 unselected). This is the cached-company-join projection pin;
  the subsequent TLS/WSS test independently covers code-only pairing with no company-display directory.
- Initial focused five suites pass 68/68 (`focused.log`). Final restored three suites pass 47/47
  (`mutations/restored.log`); they overlap 46 initial tests and add the cached-name recommendation pin.
  Therefore these runs cover 69 distinct cases across five files, not 115 distinct tests. The standalone final
  recommendation run is 11/11 and overlaps the restored run completely.
- The actual initialized/sealed Hub factory test passes one selected case; 134 unselected cases are excluded
  (`factory.log`). It asserts the member endpoint returns the configured name. Owned TLS/WSS member tests cover
  code-only discovery, profile digest unchanged, foreign binding/issuer rejection, old404, blank/Unicode names,
  stale held response, physical abort, invalid/oversize/redirect responses and missing bearer, plus startup and
  update eligibility while the metadata response is held. Update launch and directory/agent work are inert.
- Five isolated source reversals each fail an assertion: null pairing name, missing production factory injection,
  snapshot rather than live update/advice names, stale cached recommendation name, and omitted cache binding check.
  Each exact source is restored; original/mutant/restored hashes and selected commands are in mutations/results.json.
  These are runtime test assertions, not a whole-program type check of each mutant. Restored source/test native
  TypeScript programs exit zero; the test program was checked again after the final cached-advice test.
- Browser stage: the actual shipped Fleet UI runs against the existing owned Fleet web fixture, using safe display
  DTOs captured from the owned TLS/WSS composition test (`ui-data.json`). The baseline is the modeled original
  producer DTO on the same UI: null name and hostname notice/advice. The fixture projects an enabled online member;
  it does not mount a live Hub runtime. Desktop/light/English and phone/dark/zh-TW baseline/candidate each capture
  consent, confirmation, and notice/banner: 12 original PNGs, 21 checks, no page/CSP failures, zero consent writes.
  All 12 originals are independently inspected directly; image-review.md records the bounded visible result.
  The browser receipt retains 172 served asset path/hash pairs. No screenshot or full-runtime coverage is inferred
  from those hashes. The two initial harness failures (missing fixture membership, nonexistent cancel selector)
  remain under browser-*-before and are not product regressions or successful capture counts.
- Final browser execution exits zero at source738034d09 with maximum sampled host load1.84. It is serial Chromium;
  both owned listeners48642/48643 and browser/process group were closed, and the browser slot was released.

Reproduction commands (maxWorkers2, load at most10):

```sh
npx --no-install vitest run tests/hub-display-name-m3172.test.ts tests/hub-pairing-api-s3c.test.ts tests/hub-member-recommendations-m3138.test.ts tests/hub-update-owner-m3144.test.ts tests/hub-member-startup-3171.test.ts --maxWorkers=2
npx --no-install vitest run tests/hub-compose.test.ts -t 'composes S1 \+ S2 \+ S3 \+ DB \+ audit' --maxWorkers=2
npx --no-install tsc --noEmit -p tsconfig.json
npx --no-install tsc --noEmit -p tsconfig.test.json
# With the existing owned smoke-fixture Playwright/Chromium environment and captured DTO:
MATRIX=quick M3172_DATA=/absolute/path/ui-data.json REPO=/absolute/worktree OUT=/absolute/output HP=48642 npx --no-install tsx scripts/manual/smoke/smoke-hub-name-m3172.mts
```

No packaged/systemd Fleet, live AD, container, vendor CLI, pane input or actual update was run. TLS/WSS production
composition and browser rendering are separate stages, not a claimed end-to-end browser-to-live-Hub rehearsal.
Risk is cosmetic fallback/staleness until the next connected refresh. Rollback reverts these product/test/skill
paths; the optional display cache can remain ignored. No migration or destructive cleanup is required.

Plain alpha sync: merge5a3da0267 has evidence63304c2ca + alpha207917591 parents. Only the incoming profile-timeline and two existing test files change. All31 source bindings and172 served-asset bindings remain exact; alpha-sync.json records parity. No local rerun is carried out for this unchanged-source sync (5afe2996); exact-head CI is required.
