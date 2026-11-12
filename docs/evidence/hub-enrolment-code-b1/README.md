# B1 backend validation

This is the original packet at 5db75bb9. The [R1 packet](r1/README.md) records the later exclusion, policy-impact and member-version corrections; [R2](r2/README.md) records explicit code Resume before first policy enable. The original small4 image repeats small3; it does not prove a fifth distinct visible handoff. R1 adds an exact-label capture assertion and refreshed images.

Precommit source-hash-bound evidence from an owned, network-none, read-only container. The receipt binds all 21 changed production modules and five technical screenshots. No pilot, real AD, backend CLI or native runtime was used.

The Hub is production source with real SQLite, TLS, audit and a synthetic LDAPS wire. The Fleet harness uses compiled `dist/hub/join/client.js`, profile/journal helpers and `dist/hub/client.js`: real key proof, Origin-bound browser handoff, AD, redemption, durable profile/journal, proof-authenticated ACK and pinned WSS. Local Fleet consent is an explicit fixture boundary. Five handoffs use actual Chromium; the rest use the same production HTTP browser routes. The screenshots show accepted sign-in waiting for Fleet completion, before redemption; they are technical evidence, not B2 UI acceptance or five full Fleet services.

- 20 distinct people: starts span 39 ms, 20 online and uses=20 in 13,670 ms; the next push refuses.
- 50 distinct people plus three simultaneous ordinary group joins: starts span 61 ms, all online and uses=50 in 41,843 ms. Hub-process RSS 349,458,432 bytes; SQLite main file 1,499,136 bytes (not WAL-inclusive).
- A separate fifty-use code is revoked after 25 issued: all later pushes refuse; uses stays 25; already-issued links remain active. No join ended expired. No plain code occurs anywhere in the Hub home; the audit chain verifies.
- Existing sign-in inflight limit remains eight. The harness admits four AD sign-ins concurrently; it does not change server limits. No approve queue retry was needed or queue text exercised.

B-L11/B-L12's five full Fleet UI journeys, queue text and packaged/systemd rehearsal remain for B2/U2. B-L10 has both the real SQLite migration/serialized-backup test and a six-check container leg: the actual previous Hub factory starts, the current factory upgrades and creates a code, the previous factory refuses enrolment-code, and a full permission-preserving pre-upgrade backup restores its successful start. This is source-bootstrap evidence, not an old packaged/systemd daemon restore. The draft remains HOLD until U2 merges and the remaining acceptance is completed. No release or merge approval is implied.

Local validation at this source: 412 unique tests across twenty targeted suites after the plain alpha sync (274 plus 137 and one added concurrent-last-slot regression; the four existing address-fixture comparisons were restored by supplying the new null field); both source and test typechecks; 17 isolated valid source reversals fail semantic assertions (the 21 product deltas carry identically after the sync, normalizing only the existing web-address migration in its shared list) and are restored byte-for-byte; 379 changelog fragments pass. Mutation logs include the initial failures and restored controls. Exact commands:

```
node_modules/.bin/vitest run tests/hub-enrolment-code-*.test.ts tests/hub-group-publication-enrollment.test.ts tests/hub-pairing-notices.test.ts tests/hub-pairing-inbox.test.ts tests/hub-simplify-upgrade-s1.test.ts tests/hub-compose.test.ts
node_modules/.bin/vitest run tests/hub-group-admin-impact.test.ts tests/hub-group-authorization-network.test.ts tests/hub-group-authorization.test.ts tests/hub-protocol.test.ts tests/hub-group-resources.test.ts tests/hub-company-join-http.test.ts
node_modules/.bin/tsc --noEmit
node_modules/.bin/tsc --noEmit -p tsconfig.test.json
python3 scripts/manual/mutation/hub-enrolment-code-b1.py
bash scripts/manual/hub-enrolment-code-b1/run.sh
node scripts/changelog-assemble.mjs --check
```

Earlier rig attempts failed at the fixture/compiler boundaries (compiler path, launcher path, non-loopback HTTP origin, concurrent sign-in over eight, incomplete ACK payload). The final run uses the correct built clients, respects the unchanged sign-in limit and persists the required journal before ACK. Those failures were not product success evidence.

The alpha sync is a true merge of 1f20b1cf3 and d2440106a: conflicts were resolved in compose/server.ts, join/service.ts and hub-compose.test.ts. It retains both migrations, the shared invitation schema and web-address retirement. The address fixture gains only enrolmentCodeId:null; original assertions remain. A new real HTTP/SQLite seam test proves code reservations retire and issued delivery still blocks the address move. The synced container run again passed 123 checks.

Rollback fixture preparation initially omitted compiled UI assets, then exposed that Node cpSync did not preserve private directory modes. The final leg uses a closed SQLite state and a mode-preserving private tar backup/restore. The product privacy guard remains unchanged; failed restore attempts are retained as fixture failures. The six final checks and restore modes are in rollback-receipt.json.
