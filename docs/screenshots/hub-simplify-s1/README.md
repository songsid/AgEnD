# S1 backend technical acceptance

Base alpha `9c98307c938b77d8eaaebf5bcd3f20c5c27dce6f`. The receipt binds all fifteen precommit production files and the three images. Committing evidence changes no product byte.

`bash scripts/manual/hub-simplify-s1/run.sh` passed **26/26** in an owned network-none/read-only container. It uses production source FleetManagers, real cookie/CSRF/Settings/company-join HTTP, verified synthetic LDAPS, Chromium and current pinned member sockets. Both peer sources use the same owned lockfile dependencies. `/legacy` is an archive of the exact base above, rather than a mock of its schemas.

- S1-L1: old Fleet joins new Hub; new Fleet joins old Hub, both online.
- S1-L2: current exact member binding sends leave; the exact row is revoked in under five seconds and `member.left` exists.
- S1-L3 and the alpha.14 regression: with maxFleets=1, a further request receives the precise limit refusal in browser and key-proved status. Stop the Hub, remove the old Fleet locally, restart, rejoin with the saved credential: the old row is revoked in the new issuance transaction, one active row remains and `member.superseded` appears once.
- S1-L4: wrong old credential cannot discount quota; a valid credential for another owner refuses. Neither revokes the existing row.
- S1-L5: a live quick offer yields `offer-pending` in browser and Fleet status; stopping it permits the same request. This uses a separate synthetic directory person so independent legs do not spend Carol's existing five-attempt/minute budget.

The reconnect push is supplied through an explicit fixture client hook because U1 owns Fleet orchestration. Local offline removal is the production pairing API; online leave uses the new production mounted-runtime method directly. No U1 UI completion or click-count claim. The technical Settings screenshots show the existing shell and green Connected/已連接 states. The source rig's v1.22.0 badge and existing copy remain visible; these are not UI mockups or a new UI approval.

Validation:

- Initial HTTP baseline: eight semantic failures before implementation; leave baseline: two invalid-frame failures.
- Final current focused run: 201/201 across ten files; restored floor/DB/enrollment/link set: 91/91 across nine files (28 overlapping tests, 264 unique tests across fourteen files). Both source/test typechecks pass. Earlier twenty unchanged company-join HTTP tests passed separately with original timeouts after two timeouts in a broad parallel run; the failure and isolated pass remain in owned logs.
- Twelve isolated compiling production reversals are caught: offer reason, superseding owner/credential, approval/issue slot discount, final audit fence, old-record CAS, negotiated leave, Fleet reason relay, exact local binding/live profile and mount generation. Exact source is restored afterward.
- Company-join v1 upgrade preserves rows/raw CAS; v2 activates once; an older component refuses. Required-audit/permit failures roll SQL back while the independent raised floor remains conservative.
- Changelog/diff checks pass; EN/zh-TW fragments included.

Owned logs: `.artifacts/hub-simplify-s1/{fail-first,leave-fail-first,final-focused,final-restored,final-mutations,final-source-types,final-test-types,company-http-isolated,container-r1}.log`. Standalone recipe and reversal script are committed. Earlier container harness failures are retained locally: duplicate variable, missing legacy launcher, missing loopback Hub resolver and combined legs exhausting the unchanged per-person admission budget. They are not product fail-first claims; the final receipt supersedes them only for this run.

This is a source compatibility/browser rehearsal, not a packaged/systemd/tmux or native Windows run. It uses no live host, account, AD or vendor. The integrated packaged/systemd journey and final reconnect UI remain U1/U2 and Lumen's final re-review. All owned scratch profiles/AD/listeners/browser were cleaned; only these technical PNGs and receipt are committed.

Rollback: company-join component v2 requires a matching pre-upgrade backup for older binaries. Do not rewind the independent authorization floor or member histories. No old Fleet is revoked before successful replacement issuance.

Reproduce focused checks:

```sh
node_modules/.bin/vitest run tests/hub-simplify-s1.test.ts tests/hub-member-leave-s1.test.ts tests/hub-member-leave-mount-s1.test.ts tests/hub-store-publication-s1.test.ts tests/hub-simplify-upgrade-s1.test.ts tests/hub-pairing.test.ts tests/hub-protocol.test.ts tests/hub-shared-modules-a.test.ts tests/hub-tls-mount.test.ts tests/hub-compose.test.ts
node_modules/.bin/vitest run tests/hub-simplify-s1.test.ts tests/hub-member-leave-s1.test.ts tests/hub-member-leave-mount-s1.test.ts tests/hub-store-publication-s1.test.ts tests/hub-simplify-upgrade-s1.test.ts tests/hub-db-audit.test.ts tests/hub-version-floor.test.ts tests/hub-group-pairing-enrollment.test.ts tests/hub-authorization-refresh.test.ts
node_modules/.bin/tsc --noEmit
node_modules/.bin/tsc --noEmit -p tsconfig.test.json
python3 scripts/manual/mutation/hub-simplify-s1.py
bash scripts/manual/hub-simplify-s1/run.sh
```
