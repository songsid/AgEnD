# Refused publication must not break a valid Hub member link

Base: `a11aa634c1b728663d3364a57d629c5d52dea706` (alpha.2 rehearsal freeze).

A join code grants Fleet enrollment, not Agent sharing. The rehearsal's group allowed asking and Fleet enrollment but not sharing. `HubCatalogService.receiveSnapshot()` correctly refused the publication. That application refusal escaped through `HubServer.receive()` to `HubSocket`, which closed the connection as `invalid`. The next handshake sent the same saved publication consent before reconciliation, repeating the failure indefinitely. An empty code-joined Fleet could connect.

The catalog now classifies policy denials and uncertain membership separately from malformed consent or failed writes. The machine listener reports only those classified snapshot refusals through the existing bounded `error` frame, retaining the current-link fence after the await. The member logs that feedback and continues reconciliation. No publication, grant, credential, policy, audit, migration or directory admission limit is broadened.

`tests/hub-code-member-link-a2.test.ts` initializes a real sealed scratch Hub and uses production directory/session/CSRF/SQLite/audit, actual code issuance and a pinned WSS member. Only the owned loopback synthetic LDAPS peer and its DNS/port routing are substituted. It proves:

- Code join and an empty snapshot connect normally.
- Sharing `probe` without a separate allowance is denied; the link and subsequent metadata reconciliation stay current.
- Reconnect resends the retained snapshot and completes. It creates no exposure or exposure provenance and consumes no second code use.
- A fresh, independently saved group sharing allowance then publishes the retained consent with group provenance.
- Unknown group membership returns retryable feedback, without replacing the accepted exposure or advancing its catalog cursor.
- A duplicate-ID snapshot still closes the link. This failure is inside the catalog, after the listener's owner gate, so a catch-all soft refusal cannot satisfy it.
- The member handles only current `denied`/`unavailable` feedback; it neither admits work nor acknowledges a receipt, and still refuses an unexpected `invalid` error.

Fail-first: before product changes the new code-join/share/reconnect case had six assertion failures (lost link, rejected reconciliation, missing feedback, and failed reconnect). The first implementation caught feedback at the HTTP service boundary; 12 existing direct-service rejection assertions failed. Moving feedback handling to the machine listener preserved that established service contract; no old assertions were removed or relaxed.

Verification:

- Five focused files: 76/76 pass (`hub-code-member-link-a2`, `hub-group-publication-enrollment`, `hub-group-publication-network`, `hub-compose-member`, `hub-enrolment-code-http-b1`).
- After expanding the uncertainty and malformed-snapshot controls: the new file passes 3/3.
- After restoring every mutation, four transport/protocol/authorization-network files pass 43/43 (including those three regression tests, so counts overlap).
- `npm run typecheck` and `npm run typecheck:tests`: exit 0 with TypeScript native compiler 7.0.2.
- Changelog assembler: 415 fragments pass; `git diff --check` passes.

Five reversals were run separately over the new regression file, with source restored byte-for-byte after each. Every run exited 1 with assertion failures; no transform or TypeError counted as proof. [Results](mutations.json) and [source bindings](SOURCE_SHA256SUMS):

| Reversal | Protected behavior |
| --- | --- |
| Replace classified denial with generic protocol denial | Refused share and replayed snapshot cannot disconnect the member |
| Replace classified uncertainty with generic protocol error | Unknown membership remains nonfatal and does not publish a new revision |
| Soften every protocol error instead of only the classified refusal | A duplicate-ID snapshot still disconnects |
| Member throws on valid refusal feedback | Current member keeps reconciling after feedback |
| Remove the code-source / legacy sharing refusal | Enrollment code cannot silently grant sharing |

Commands use `node node_modules/vitest/vitest.mjs run <files> --maxWorkers=1 --cache=false --configLoader runner`. Full suites remain CI's responsibility.

Compatibility and limits: the wire schema is unchanged and no browser assets changed. This is not a browser, packaged/container, native-Windows, real-account or real-directory rehearsal. The preserved rehearsal container was not started or changed. Both Hub and member need the new handling to get nonfatal feedback; an older member can parse the existing frame but still treats it as unexpected. Local `published` remains saved owner consent, not a remote acceptance receipt. A refused publication stays absent on the Hub until separately authorized.

Rollback: revert this change. No data/schema rewrite is needed; saved credentials, consent and provenance remain intact. The previous refused-publication reconnect loop returns.
