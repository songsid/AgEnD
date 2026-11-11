# S2 acceptance

Base alpha `9c98307c938b77d8eaaebf5bcd3f20c5c27dce6f`. The receipt binds the precommit production bytes by digest; committing this evidence changes no product byte.

- Fail-first: the new real-HTTP/verified-LDAPS cases failed with missing endpoint responses before implementation (five semantic failures).
- Final focused run: 186/186, ten files: the three `hub-group-search-*-s2` suites, group-admin-directory-wire, group-directory, group-admin-read, groups-mount-s89, group-admin-control, group-admin-dto and hub-shared-modules-a.
- Separate unchanged Hub composition suite: 111/111, for 297 tests across eleven distinct files.
- Both `node_modules/.bin/tsc --noEmit` and `node_modules/.bin/tsc --noEmit -p tsconfig.test.json` pass.
- Eight isolated production reversals compile and fail their intended assertions: RFC literal escaping, size/time limits, shared pool, same-session check, directory-generation check, rate limit and physical close await. Exact source restored; final focused run passes.
- `bash scripts/manual/hub-group-search-s2/run.sh`: 43/43 real Hub/LDAP checks in an owned read-only, network-none container, covering S2-L1–L4, timeout/socket settlement and no enrolled resource.

Commands and owned logs: `.artifacts/hub-group-search-s2/{fail-first,final-focused,mutations,container,final-source-types,final-test-types}.log`. Mutation recipe: `scripts/manual/mutation/hub-group-search-s2.py`.

No UI change or PNG claim. The container uses source modules, not a packed/systemd installation; it has no external network, native or live AD/account. The integrated packaged browser/systemd journey belongs to U2 and Lumen's final re-review. Temporary Hub/AD state and sockets were removed; only the receipt remains. Rollback removes the search endpoint and requires no database restore.

## R1: reviewer guard pins

Production source is byte-identical to `b5cc851d23f201d3681ecfb90a8be6a593988936`. This revision only adds tests, inert wire controls and mutation evidence. The original source-bound 43-check container receipt remains applicable; no new rig or native claim.

- A matching distribution group is excluded, and the actual BER filter must include the security-group matching-rule/bit. The parsed prefix literals remain separate from their trailing wildcard.
- An outside-base DN returns `unknown`; changing that same row to an in-base DN succeeds.
- A peer deliberately ignoring sizeLimit and returning 21 entries is refused by the directory driver itself; the compliant 20-entry/truncated control passes.
- A repair-required binding returns `unknown` without calling the directory; restoring readiness permits the same search.
- A verified TLS peer delays the service bind by 3 seconds and then stalls the search. The whole-operation timer returns `unreachable` at its 5-second deadline and the owned socket is closed (test permits 4.5–6.5 seconds of measured elapsed time). Removing only `service?.abort()` returns after 8,007 ms instead and fails the deadline assertion; the individual LDAP request timer cannot substitute for the whole budget. An immediate-answer control succeeds afterward.

The five corresponding isolated production reversals all compile and fail semantic assertions. They are appended to `scripts/manual/mutation/hub-group-search-s2.py`; run with `security-group group-base deadline-abort ready-binding reply-bound` to select just this round. Exact production bytes are restored. The initial mutation runner selected two similar base checks and refused to mutate; its selector was narrowed before the five successful proofs. That harness refusal is not counted as a protected assertion.

Owned logs: `.artifacts/hub-group-search-s2/{r1-green,r1-mutations,r1-final-focused,r1-source-types,r1-test-types}.log`. CI/review must settle at the new submitted head; old green is not carried as a new-head check.

R1 final restored verification: **300/300 in eleven files, zero skips**, using the command below in one run. Both source and test typechecks pass. All eight source digests match the R0 receipt and `git show b5cc851d:<path>` byte for byte. The five new mutation failures are semantic assertions; the deadline reversal reports 8,007 ms against the 6,500 ms ceiling. All delayed fixture timers and sockets settle during cleanup.

```sh
node_modules/.bin/vitest run tests/hub-group-search-s2.test.ts tests/hub-group-search-boundary-s2.test.ts tests/hub-group-search-close-s2.test.ts tests/hub-group-admin-directory-wire.test.ts tests/hub-group-directory.test.ts tests/hub-group-admin-read.test.ts tests/hub-groups-mount-s89.test.ts tests/hub-group-admin-control.test.ts tests/hub-group-admin-dto.test.ts tests/hub-shared-modules-a.test.ts tests/hub-compose.test.ts
```
