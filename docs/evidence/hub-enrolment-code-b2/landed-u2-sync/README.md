# Landed U2 sync before combined acceptance

Plain merge 44e096122176301162d07977a644433ae1d68af1 composes landed U2/alpha 4f82fc4e with synced B1 fcc9ebbce. The resolved client keeps U2's joinMetadata and B2 code CRUD/notice methods; module allowlists keep both sets. The incoming welcome and two revised U2 tests are exact. The pairing API tests retain both the compatible notice request and U1 post-leave disconnect-authority recheck. The Fleet input, join steps, picker and welcome match the incoming alpha bytes.

All 32 product added/removed-line sequences against the respective U2 bases match the prior B2 composition (including its B1 dependency). No new product behavior was introduced by this sync. Focused verification passes 301/301 in 22 files, zero skips, both native typechecks, changelog assembly and B2 diff checks. Source hashes and the comparison are in source-binding.json. The earlier 28 semantic source reversals and four full-card reruns remain historical; they were not all repeated here.

The prepared campaign now checks load and MemAvailable before starting and every second while running. Load >=12 or memory <4096 MiB writes this attempt's STOP. Seven pure interlock tests pass; removing the load and memory guards separately fails the intended assertions, with exact restoration. The runner owns its CID/image label and cleans only those resources. Administrative screenshots share one real code and end it once, preserving the product's ten-creations/hour policy rather than bypassing it. Static parsing succeeds; runtime imports/locators still require the authorized campaign.

Commands:

```
node_modules/.bin/vitest run <21 paths from the preceding full-u2-composition receipt> tests/hub-enrolment-campaign-guard.test.ts --maxWorkers=1
node_modules/.bin/tsc --noEmit
node_modules/.bin/tsc --noEmit -p tsconfig.test.json
node scripts/changelog-assemble.mjs --check
bash -n scripts/manual/hub-enrolment-code-campaign/run.sh
node --check scripts/manual/hub-enrolment-code-campaign/host-watch.mjs
```

No new Chromium, capacity, package, real account, pilot or native operation is claimed in this packet. Combined B-L*/UI/SKEW evidence will bind the actual tested SHA separately. The leader's delivered GO authorizes that later campaign with strict 2 CPU/3 GiB limits, current host budget checks and no overlapping heavy campaign. B1 must merge before B2; parity review follows acceptance.
