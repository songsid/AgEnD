# Hub metadata ownership: matched VM reads

This follow-up removes graph copies from two scalar-only currentness paths. It does not coalesce or cache an authority, floor, private-path check or request frame. The held guard-frame work is not included.

## Profile and change

Fresh baseline V8 profiles on the synthetic two-vCPU VM still attribute about 630/795/197 ms of sampled self time to `structuredClone` across three exposure/detail/list reads. Directory settings inspection calls policyRow only for the SQL Hub owner and raw hash, and transport reads only for revision/revocationVersion. Those graphs have no caller that needs ownership there.

The transport has one checked-image path: fresh SQL/exact bytes, decode validation, independent floor equality, duplicate-ID checks and permanent failure. Owning read() returns a deep copy; readVersion() returns two scalar values. The authorization clock keeps both method-identity fences and two separate fresh reads. Fake read-only ports retain the owning-read fallback; a production-store control prevents silent fallback.

The canonical codec has one private validated image. Its owning parser still returns an isolated copy; byte-only validation returns nothing. Directory inspect still reads fresh SQL, strictly validates changed bytes, checks hub_id and hashes the fresh raw bytes. Writer/decide/latestPolicy/proofBasis continue through the owning policy path; proof views remain copied.

## Matched measurements

Same synthetic count fixture as the preceding reports:17 people,8 Fleets,9 shares,50/70 posts,8/14 room members,2 teams/16 memberships,3 roles/2 assignments,5 grants,15 direct rooms/85 inert messages. Two VM CPUs, Node 22.23.5, `taskset -c 0,1`; separate processes/private homes for each variant, baseline before candidate. One untimed priming GET per endpoint, then median of three recorded reads. No profiler during timing; call-site counters keep function identities. Every timing row is HTTP 200. No production process, directory, provider or content is used.

| Route | CPU ms before/after | Clones before/after | CPU reduction |
| --- | ---: | ---: | ---: |
| `/hub/v1/exposures` | 814.2 / 670.7 | 8528 / 3246 | 17.6% |
| `/hub/v1/rooms/room-70` | 1046.1 / 858.9 | 11578 / 4403 | 17.9% |
| `/hub/v1/rooms?v=2&ownerRequests=1` | 272.2 / 224.2 | 2767 / 1035 | 17.6% |
| `/hub/v1/admin/ai-apps` | 65.5 / 54.6 | 612 / 236 | 16.6% |
| `/hub/v1/admin/company-join` | 61.9 / 52.0 | 566 / 218 | 16.0% |
| `/hub/v1/admin/dashboard?range=7d&timeZone=UTC` | 141.0 / 122.9 | 674 / 260 | 12.8% |
| `/hub/v1/admin/enrolment-codes` | 77.7 / 63.8 | 715 / 273 | 17.8% |
| `/hub/v1/admin/group-policy` | 89.0 / 73.0 | 738 / 284 | 18.0% |
| `/hub/v1/admin/hub` | 68.0 / 56.3 | 621 / 239 | 17.2% |
| `/hub/v1/admin/overview` | 174.5 / 145.4 | 1347 / 519 | 16.7% |
| `/hub/v1/admin/personal-agents` | 69.5 / 57.0 | 642 / 246 | 18.0% |
| `/hub/v1/admin/recommended-version` | 60.9 / 51.2 | 569 / 219 | 15.8% |
| `/hub/v1/admin/rooms` | 66.8 / 57.4 | 618 / 238 | 14.0% |
| `/hub/v1/admin/rooms/creators` | 67.5 / 56.0 | 618 / 238 | 17.0% |
| `/hub/v1/admin/session-limits` | 61.7 / 53.4 | 569 / 219 | 13.6% |
| `/hub/v1/roles` | 120.4 / 109.5 | 831 / 317 | 9.1% |
| `/hub/v1/roles/audit` | 87.1 / 74.8 | 727 / 279 | 14.0% |
| `/hub/v1/teams` | 81.9 / 68.0 | 779 / 297 | 17.1% |
| `/hub/v1/teams/settings` | 91.0 / 73.4 | 724 / 276 | 19.3% |

The three principal routes reduce median CPU by 17.6–17.9%, with about 62% fewer graph copies. All three principal reads still exceed the earlier ~100 ms target. These are server process CPU samples, not end-to-end click latency or an SLA. All private-path/floor checks still run. Process counters include any interleaved work: their complete ranges are retained in verification.json rather than claiming exact per-sample equality.

The fixture does not mount the assistant settings/usage ports or directory-editor subview. Their diagnostic 404s are excluded from timing evidence. People uses the roles read; Connected Fleets uses admin/overview. Teams, role audit, allowed list, personal agents and AI apps are included above. Browser navigation/rendering and live Mac or post-deployment timings are not measured.

## Verification and rollback

The old scalar/inspection paths fail four explicit clone-count assertions. The candidate passes 195 tests across five focused files, then seven final metadata controls (four overlap), covering malformed/duplicate raw bytes, equal-length SHA changes/conflicts, foreign Hub ownership, owned nested mutation and synchronous proof-view isolation. Source and test typechecks pass. Eleven unsafe mutants fail on assertions: skipped floor, stale version, lost permanent failure, either method fence, reused confirmation, missing SQL owner, stale hash, skipped strict validation, leaked codec image and leaked proof basis.

Runtime source bindings, bundle/report digests and every timing range are in verification.json. Raw synthetic profiles/reports remain private. The earlier clock-only exploratory samples are not the final comparison. The original production stall attribution was not instrumented retroactively; the preceding beta removed the reported one-second stalls, while this patch targets remaining request CPU. More vCPUs do not parallelize these synchronous paths.

Revert this patch independently: no migration, persistent-format change, timer, retry or authorization lifetime change. Private-path work remains a separate profile-guided follow-up, with the guard frame still held.
