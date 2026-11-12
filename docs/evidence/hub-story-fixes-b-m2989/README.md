# Hub flow gaps 10, 14 and 18 (M-2989)

The CLI now names **Administration → Let colleagues join / 管理 → 讓同仁加入** and the actual advanced pairing-code disclosure. An owner's grant list marks recipients who have never signed in. Browser setup checks the exact saved Hub before offering sign-in, without asking the user to reload Settings.

Lumen's findings are source observations on `docs/hub-ux-review-m2902@4229a3a81`, stories A1, M2 and A2 in `docs/evidence/hub-ux-stories-m2986/data.json`. They were not earlier runtime reproductions. The changes here are limited to findings 10, 14 and 18. Ridge's #3751 and dev-claude2's #3750 own separate portions of the shared files; no grant-row/catalog overlap was reported.

## Behavior and boundaries

- `subjectSignedIn` is read from the immutable recipient key's `hub_people` row in the final catalog transaction. Directory eligibility lookups do not create that row; successful directory sign-in does. Signing out does not erase the witness. Only the exposure's owner receives this grant projection. No migration or new directory operation.
- The existing D3 setup inspection route reports the configured Hub ID, web origin and the runtime's existing `serverHealth(expectedConfig)`. It neither mounts a server nor probes a network address. The existing host/session/public-link checks remain in force.
- After a successful commit, the page reads that route and requires the same Hub ID and web origin plus `ready`. Starting mounts are checked serially at two-second intervals, at most 30 reads. A missing field, mismatched identity, unavailable mount or failed read offers **Check again / 再次檢查**; checking never repeats Create. Session end and unmount abort and fence late replies.
- New labels are registered with the fresh renderers. An old grant DTO omits the marker rather than being treated as never signed in. An old setup DTO cannot offer sign-in without readiness evidence.

## Tests

The initial modified-test fail-first run produced 14 assertion failures and 129 passing controls. The pinned replay in `checks/baseline-replay.json` uses all six current test files against the six product files from alpha `a6557a6b3e328b1586de0f853390aabb8f0ad99f`: **17 assertion failures, 157 passing controls**. The receipt binds both input sets and records exact restoration. It is a baseline replay, not an execution of the final candidate.

After restoration, the six focused suites pass **174/174**, including real cookie/CSRF/verified-LDAPS/HTTPS setup and an unmounted-versus-mounted control. Source and test native TypeScript checks pass. Six isolated guard reversals each compile and produce assertion failures; `checks/mutation-summary.json` names the pattern and counts. The successful final run follows exact restoration.

```sh
npx vitest run --maxWorkers=2 tests/hub-grant-recipient-3370.test.ts tests/hub-init-setup-bugs-2917.test.ts tests/hub-web-init.test.ts tests/hub-web-setup-ui.test.ts tests/hub-ui-s3.test.ts tests/hub-web-init-http.test.ts
node node_modules/@typescript/native/bin/tsc --noEmit
node node_modules/@typescript/native/bin/tsc --noEmit -p tsconfig.test.json
node scripts/changelog-assemble.mjs --check
```

## Browser evidence

One serial Chromium 156 campaign, with load checks at each leg; the other rehearsal owner released the browser slot and was notified when this campaign finished. Only owned scratch AGEND_HOME/Fleet state, in-process fake directory services and loopback listeners were used. No container, live Fleet, real AD/account, model CLI, service install or Mac pilot operation.

| Run | Cases | PNGs | Scope |
| --- | ---: | ---: | --- |
| setup-before | 8 | 8 | Exact base setup renderer over candidate backend; reproduces immediate sign-in and reload instruction |
| setup-current | 8 | 16 | EN/zh-TW × light/dark × 1366px desktop/390px phone; held readiness reply then actual ready |
| setup-old-words | 2 | 4 | New renderer with exact retained setup dictionary |
| setup-old-server | 2 | 4 | Real inspection reply with the new runtime field removed; no sign-in link |
| grants-before | 8 | 8 | Exact base Hub renderer over candidate catalog |
| grants-current | 10 | 10 | Eight current cases plus retained owner dictionaries and an old grant DTO |
| setup-phone-actions | 4 | 12 | Fresh phone supplement, sign-in CTA scrolled into view; EN 144.09×44px, zh-TW 118.33×44px |

All **42 cases / 62 PNGs** pass their declared checks. The before cases substitute exact renderer blobs from `a6557a6b`; they are not full old-server runs. Old-server controls remove only the new response field. CSS is unchanged from that base. There is no claim of a full all-old-assets or native-browser matrix.

Each original receipt records capture-time HEAD/tree, empty tracked-dirty state, source/harness digests, served asset digests and exact substitutions. `capture-checks.json` verifies the input bindings against Git objects. Setup originals bind to `74b658122`; grant originals to `f37e80896`; the phone supplement binds to `d5e0340b3`. These executions retain their original identities. All six product blobs are unchanged across those original capture heads and pre-sync head `6e1745252`. Their comparison head is explicit in `capture-checks.json`; later sync evidence is separate below.

The setup button's 44px phone target is checked numerically, including the supplement. Grant Allow/Refresh/Pause controls are pre-existing 30px phone targets; the receipts compare them to the same baseline and assert no new small controls. The new grant marker is display-only. Those existing controls were not resized in this scoped change.

Selected current originals and supplements received an image-only review (26 originals). No visible blocker; no interaction inferred from the still images. Browser assertions cover the held reply, successful transition, missing-field refusal, overflow and unchanged small grant controls. The temporary failing harness diagnostics are not acceptance runs and are not relabelled as passes.

To repeat, set `PW_DIR` and `CHROME` to an isolated Playwright installation, then run `scripts/manual/hub-story-fixes-b-m2989/setup.mts` and `grants.mts` with `node --import tsx`, `OUT=<owned output>` and `REPO=$PWD`. `MODE=before`, `SKEW=old-words|old-server` (setup), `MATRIX=quick|full` (setup), and `BASE_REF` select the recorded controls. Grant current needs the preceding baseline receipt at `../grants-before/receipt.json`, or `BASELINE_RECEIPT`.

## Risk and rollback

The new inspection fields and grant boolean are additive, display-only data. Older clients ignore them; newer clients fail closed when fields are absent. Readiness is a local runtime observation, not a promise about external routing or a person's future sign-in. Reverting this PR restores the prior display behavior without a data downgrade or storage change.

## Sync after #3750

Alpha moved to `b5514e36dc61482ad5bce6aeea7603f5e9a6be41` while review was in progress. Plain merge `2813ba6c6a34fcb14e88d8079514f02cb8045f46` was clean, including the two overlapping files (`panel-hub.js` and `hub-ui-s3.test.ts`). All six of this PR's source patches remain identical, added/removed line for line, against the new base (`sync-3750/checks/parity.json`). The incoming helper/approve/revoke changes are retained.

#3750 changed the denied message. The session-end test now checks the current dictionary rather than its old literal, while retaining the abort/no-link assertions. It also asserts that the created heading is removed: Fable's U6 reversal is now caught by one semantic failure; restoration passes 47/47 in the two changed/related suites. The final combined seven suites pass **193/193**, and both native type checks pass.

Surrounding visible Stop sharing and Fleet connection wording changed, so new captures were taken at clean head `4a4e6473d` rather than relabelling the earlier runs. The sync supplement adds **26 cases / 42 PNGs**: eight current setup cases with visible actions, eight post-3750 baseline grant cases and ten current/SKEW grant cases. All checks pass. Ten selected new originals were visually clear; the full Stop sharing section remains below the phone stills' viewport. Browser resources were cleaned and the slot returned to the rehearsal owner again.

The complete gallery now contains **68 declared cases / 104 original PNGs**, with the original 42/62 scope retained. Latest phone actions: [zh-TW dark](sync-3750/browser/setup-current/phone-dark-zh-TW-ready-actions.png), [EN light](sync-3750/browser/setup-current/phone-light-en-ready-actions.png). Latest grant marker: [zh-TW phone](sync-3750/browser/grants-current/current-phone-dark-zh-TW-grant.png), [EN desktop](sync-3750/browser/grants-current/current-desk-light-en-grant.png).
