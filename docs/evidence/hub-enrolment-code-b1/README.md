# B1 backend validation

Precommit source-hash-bound evidence from an owned, network-none, read-only container. The receipt binds all 21 changed production modules and five technical screenshots. No pilot, real AD, backend CLI or native runtime was used.

The Hub is production source with real SQLite, TLS, audit and a synthetic LDAPS wire. The Fleet harness uses compiled `dist/hub/join/client.js`, profile/journal helpers and `dist/hub/client.js`: real key proof, Origin-bound browser handoff, AD, redemption, durable profile/journal, proof-authenticated ACK and pinned WSS. Local Fleet consent is an explicit fixture boundary. Five handoffs use actual Chromium; the rest use the same production HTTP browser routes. The screenshots show accepted sign-in waiting for Fleet completion, before redemption; they are technical evidence, not B2 UI acceptance or five full Fleet services.

- 20 distinct people: starts span 19 ms, 20 online and uses=20 in 9,106 ms; the next push refuses.
- 50 distinct people plus three simultaneous ordinary group joins: starts span 36 ms, all online and uses=50 in 39,237 ms. Hub-process RSS 377,782,272 bytes; SQLite main file 1,486,848 bytes (not WAL-inclusive).
- A separate fifty-use code is revoked after 25 issued: all later pushes refuse; uses stays 25; already-issued links remain active. No join ended expired. No plain code occurs anywhere in the Hub home; the audit chain verifies.
- Existing sign-in inflight limit remains eight. The harness admits four AD sign-ins concurrently; it does not change server limits. No approve queue retry was needed or queue text exercised.

B-L11/B-L12's five full Fleet UI journeys, queue text and packaged/systemd rehearsal remain for B2/U2. B-L10 is currently covered by the real SQLite migration/serialized-backup test, not an old packaged daemon restore. The draft remains HOLD until U2 merges and the remaining acceptance is completed. No release or merge approval is implied.

Local validation at this source: 344 unique tests across sixteen targeted suites (206 + 137, plus the additional budget regression); both source and test typechecks; 17 isolated valid source reversals fail semantic assertions and are restored byte-for-byte; 377 changelog fragments pass. Mutation logs include the initial failures and restored controls. Exact commands:

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
