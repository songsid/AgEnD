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
