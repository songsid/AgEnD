# Member-address head: keep the check, skip the unused graph

Fresh V8 profiles on merged release `53e37ad8762e8290dd2f83aa752367f48b33a228` (including #4594, #4595 and #4601) identify a remaining transport-copy path: `createHubMemberAddressDecision().head()` calls `transport.read()` only to trigger fresh validation and discards the returned graph. The candidate changes exactly that call to the existing production `readVersion()` method. It uses the same private `checkedImage`: fresh SQL/exact image, strict decoding, independent floor equality, duplicate IDs and sticky failure. The member-address head and operation are still read and validated afterward. There is no production fallback.

All other methods—including inspect, affected/stateFleets, fleetBinding, reserveRelocation, assertOperation and writers—are unchanged and retain their owning reads. No transport API, cache, path checker, authority scope, lifetime, timer, retry, migration or persistent format changes. The rejected #4602 leaf-stat candidate is absent; the held guard frame is untouched.

## Regression and types

On the baseline, the new four-control suite has one assertion failure (head uses no scalar reads) and three positive controls. The candidate passes all 80 tests across six named member-address/transport files, including the four controls. Those pin production scalar use with no owning read or clone, fresh independent-floor refusal plus sticky failure after repair, corrupt transport SQL throwing `uncertain`, and continued fresh head/operation validation. Constructor grep finds real `HubTransportStore` fixtures rather than a fake requiring fallback. `tsconfig.test.json` (src/tests/e2e, no emit, GOMAXPROCS=2) passes. Existing scalar-reader validation and ownership controls from #4601 carry unchanged; counts are not added to the 80 fresh tests.

## Fresh profile

An in-process inspector Session profiles only synthetic scratch Node processes on the same two-vCPU VM (Node 22.23.5, taskset0,1,512MiB heap cap). It opens no inspector listener and never attaches to production. Each endpoint has one untimed priming read followed by three profiled reads at a1000µs sampling interval. Product counters are disabled in profile bundles. All245Hub modules are source-bound; unchanged fixture support modules use the installed runtime.

There are22profiles: the three main routes and19admin endpoints. Nineteen endpoints returnHTTP200 (57recorded reads); three unmounted conditional endpoints returnHTTP404 (9diagnostic reads) and are excluded. `verification.json` includes each successful route’s top10self-time functions/caller paths plus aggregate top10 and raw-profile hashes. V8 sampled self time is elapsed stack residency, **not precise CPU accounting**; profiled CPU includes instrumentation overhead. The fresh profiles justify selecting this one path; the separate unprofiled comparison measures its gain.

## Matched unprofiled comparison

Separate baseline and candidate processes use the same synthetic fixture and Node runtime/default heap, with one untimed priming read and three recorded reads per endpoint. Each bundle binds245Hub modules and only the member-address module differs. The132recorded rows are classified:114HTTP200 timing rows and18unmountedHTTP404diagnostics excluded. Every row retains equal fresh transport/floor counts. Interleaved work can alter process-level counts across variants.

| Principal read | CPU median before → after (ms) | Change | Clones before → after |
| --- | ---: | ---: | ---: |
| Exposures | 667.884 → 597.152 | −10.59% | 3246 → 748 |
| 70-post room detail | 853.240 → 758.596 | −11.09% | 4403 → 1003 |
| Room list | 221.569 → 200.817 | −9.37% | 1035 → 208 |

All ranges and the16available admin endpoint results are retained in `verification.json`. Baseline ran before candidate, and the sample is bounded; this is no production/browser latency or100ms-target guarantee. No production profiling, configuration, restart, provider/native/browser/container campaign or Mac measurement was performed. Owned synthetic VM scratch was removed.

## Rollback

Restore the single `head()` call to `transport.read()`. No state conversion or migration is needed. The metadata-reader fix in #4601 remains independent.
