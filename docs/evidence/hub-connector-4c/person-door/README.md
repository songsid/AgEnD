# Connector 4c: Hub HTTP and person tools

This second M-3240 slice composes the first slice's authorization service directly on the existing Hub web listener. It is held as a draft until the consent/setup pages and real-app acceptance arrive in the third slice. No browser feature or installation prompt is advertised, and administrator app access starts disabled.

The restored source passes **114 tests in eight files**, including **25 new door controls**, the existing 25 authorization controls and the local 4a connector regression. Both source and test TypeScript programs exit 0. Changelog assembly and `git diff --check` pass. `manifest.json` binds the source, tests and supporting inputs; the source base is recorded separately from their current hashes.

```sh
npx vitest run tests/hub-mcp-door-m3240.test.ts tests/hub-mcp-auth-m3240.test.ts tests/owner-app-connect-m3221.test.ts tests/hub-s3b-server.test.ts tests/hub-s3b-flow.test.ts tests/hub-rooms-r1.test.ts tests/hub-rooms-migration-r1.test.ts tests/hub-room-files-3125.test.ts --maxWorkers=2
npx tsc --noEmit -p tsconfig.json
npx tsc --noEmit -p tsconfig.test.json
node scripts/changelog-assemble.mjs --check
git diff --check
```

The actual loopback HTTP/SDK controls cover OAuth discovery and exchange, browser-versus-bearer and CSRF boundaries, a static eight-tool catalog, consent scopes, live person/group/team eligibility, default-off administrator and default-on room policy, person-via-app attribution, shared-room-only reach, exclusion of the Hub assistant and browser/other-app direct history, file-name-only projection and audience floors. New direct asks run the existing grant/release-answer lease path; the response contains only the app's question. Persistent intents recover after mount restart and after a committed post or ask loses its result, without an extra delivery or quota charge.

The feature-disable control covers unused apps across disable/re-enable. An additional policy remove/re-add probe was assertion-red before the writer fix (`policy-before.log`): an unused credential survived. Policy changes now end every current app grant atomically, so use during the denial is irrelevant. The final test includes a recent exclusive `since` anchor over a history longer than fifty messages; its initial phantom-page assertion was fixed before the final run. A legacy room DTO expectation was updated only to include the intended default-on `aiApps` field.

Three guard removals were run separately in one campaign: consent-scope checking, app-private ask-result selection and the five-post ceiling. Each turns one selected test assertion-red (24 unselected tests excluded per case). The exact original source hash is restored. These were runtime-transformed TypeScript reversals; only the final restored source/test programs received the full type checks.

This packet uses owned SQLite, inert directory/member links and owned loopback listeners. It does **not** claim browser consent, real Claude Code/Codex, certificate trust, a live Hub/AD/Fleet, personal account configuration or packaged installation. Those remain the third slice. Existing first-slice evidence stays historical and is not relabelled as HTTP or CLI proof.

Rollback disables apps and ends grants, then uses a compatible fix retaining the two new schemas and frozen attribution/history. Do not drop history or run an older binary against a newer schema registry. The direct Hub URL remains the intended no-local-install path; there is no proxy, trust bypass or Fleet credential conversion.
