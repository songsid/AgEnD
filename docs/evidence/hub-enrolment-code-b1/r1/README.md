# B1 R1: exclusions, impact inventory and member presentation

The three reviewer P2s were reproduced first: two new/retained permit assertions, four real admin/HTTP preview/apply assertions and the member Settings v2 response assertion failed at 5db75bb9. The source correction is confined to four modules:

- `group-policy/resources.ts`: code admissions and retained code Fleets honor explicit exclusions before the first group enable. Confirmed batch suspension permits only an explicitly excluded code Fleet in that state; a negative control keeps all other never-enabled batch suspensions refused. Existing manual/legacy rules are preserved.
- `group-policy/admin-impact.ts`: the preview names an excluded code Fleet and the same owning policy transaction suspends it, including never-enabled state.
- `group-policy/impact-inventory.ts`: stored-source parsing accepts authenticated code provenance for active and revoked Fleet history, while malformed stored bodies still refuse.
- `settings-api.ts`: member Settings returns group notices by default/unknown version, manual as well at v2, and code only at explicit v3. The existing v2 client and strings are untouched. The inbox retains all notices; no code row is mislabeled as group approval by an older page.

The corrected three suites pass 57/57. The final restored run, including existing policy controls, resource lifecycle, authorization and inbox regressions, passes 205/205 across eight files, zero skips. One initial broad run timed out in a newly added revoked-history case; its isolated control exposed that the fixture used the owner endpoint with an administrator. The fixture now uses the existing configured-admin revoke route. No timeout, process guard or expected permission result was loosened.

Six additional isolated reversals cover never-enabled admission, retained check, impact parsing, confirmation plan, confirmed suspension and member version filtering. Each passes the native source typecheck and then fails the intended semantic assertion, with byte-exact restoration; see [mutations.json](mutations.json). The first impact-parser run failed only through an opaque fixture error, so it was excluded from the semantic count. The test now asserts the real preview HTTP status directly, and the isolated rerun fails that assertion. The original seventeen guards carry on their unchanged source/semantics.

```
node_modules/.bin/vitest run tests/hub-enrolment-code-http-b1.test.ts tests/hub-enrolment-code-permit-b1.test.ts tests/hub-pairing-api-s3c.test.ts tests/hub-group-admin-control.test.ts tests/hub-group-admin-impact.test.ts tests/hub-group-resources.test.ts tests/hub-group-authorization.test.ts tests/hub-pairing-inbox.test.ts --maxWorkers=1
python3 scripts/manual/mutation/hub-enrolment-code-b1.py never-admission never-retained impact-source never-impact never-batch member-version
node_modules/.bin/tsc --noEmit
node_modules/.bin/tsc --noEmit -p tsconfig.test.json
node scripts/changelog-assemble.mjs --check
OUT="$PWD/.artifacts/hub-enrolment-code-b1/r1-container-diagnostic" bash scripts/manual/hub-enrolment-code-b1/run.sh
```

The [container packet](receipt.json) is a refreshed precommit source-hash-bound technical handoff/capacity run: 123/123 checks pass, binding 23 production files and five images. Twenty connects in 21,993 ms (starts span 56 ms); fifty plus three ordinary group joins connects in 50,657 ms (starts span 75 ms), uses=50, all 73 prior/current links online. Hub RSS is 384,528,384 bytes; the main SQLite file is 1,515,520 bytes, excluding WAL. Mid-wave revoke stops new issuance at 25 and leaves issued Fleets active. No join expires, no plain code is found in the Hub home, and the audit chain verifies. No queue retry was needed; queue text remains unexercised.

The [two earlier R1 attempts](earlier-attempts.json) failed at the fixture's unchanged five-second request timeout, after 115 and 83 checks respectively. They are not full success claims. A diagnostic-only change adds method/path to that timeout error; it changes neither timeout nor product behavior. The next unchanged-timeout run passed all 123 checks. The timeout cause was not established, so this is no causal fix or stability claim. Full failed logs remain local. Capture now waits for the exact requested Fleet label before each PNG. Five full Fleet services and B2/U2 UI acceptance remain separate. The prior six-check bootstrap/rollback packet carries on unchanged migration/bootstrap code.

All five refreshed images were inspected at full resolution through the CLI image agent. Each filename matches the visible `Owned small0` through `Owned small4` label and test address; small4 is distinct from small3. No clipping, overlap or secret-like values were found. small3's Chats sidebar shows a retry error; small2 and small4 retain sidebar loading placeholders. The main panels show accepted company sign-in with connection pending, not a clean full-shell acceptance. Completed pinned links and capacity are separate protocol assertions, not visual claims.

U2 merge-order HOLD, plain sync, current-head CI and final readiness review remain. Evidence goes directly to parity; Lumen owns the combined final owner UX walk-through.
