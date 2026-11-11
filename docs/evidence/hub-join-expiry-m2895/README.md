# Expired company-join Start recovery (M-2895, alpha.14)

The alpha.13 rehearsal left a local operation at `held / expired / issued:false / outcomeKnown:true`. `priorBlocks()` ignored its deadline and required a cancelled/ended stage, so every fresh authorized Start conflicted permanently, including after Fleet restart. The ten-minute live wait still blocks another Start by design.

The controller now recognizes expiry only with **both** `issued:false` and `outcomeKnown:true`. Its existing read DTO projects that attempt as `ended / expired`; the existing Settings form already accepts that state. A new explicit Start selects a new operation and generation while keeping the old private journal. It neither renews the old deadline nor reuses its requester, key or consent. Issued, uncertain, still-live and bound-profile fences stay in place. No schema, route, authority, credential or UI-module change.

## Checks

- `fail-first.log`: five semantic failures and 22 passing controls against unchanged alpha.13 `1066a85a2`; three fresh-Start conflicts, the expired DTO assertion and the reconstructed FleetManager conflict. This is a historical pre-commit diagnostic. Its FleetManager case was then separated into `hub-company-join-restart.test.ts` to keep the controller suite independent of the large FleetManager import.
- `focused.log`: 62/62 local/controller, production FleetManager reconstruction, Settings authority/replay, private durability and mounted UI checks. `broader-initial.log` retains the earlier 78 pass / one unchanged Hub quota test deadline at 10 seconds. The exact quota control then passed in isolation (1 pass, 19 deliberately unselected), with no retry loop or deadline change; see `isolated-http-control.log`. The 19 other Hub HTTP tests passed in the broader run.
- `mutations.json`: independent single-guard reversals, each requiring assertion failures, with exact source restoration. Includes expiry recovery, outcome-known, issued, live deadline, ended projection, the exact deadline boundary and the live-prior gate. No compile-only failure counts as a caught guard.
- Production and test type checks, changelog assembly validation and diff check. Commands and results are in `checks.json`; `manifest.json` uses digest-first bindings for the evidence and changed inputs.

## Clean-member follow-up

`hub-company-join-recovery.test.ts` uses a sealed scratch Hub, actual HTTPS/WSS, the production AD directory driver over an owned fake LDAPS peer, and a never-paired private member HOME. The only TLS connector redirections are the fixture's DC endpoint and fixture Hub hostname to their owned loopback listeners; TLS verification and pins remain active. Only dummy service/personal credentials are used.

Carol signs in and approves the exact request; the production local controller redeems, persists, ACKs and enables membership. The production member factory then reconciles online, closes and reconstructs over the same private files, and becomes online again. **The reported held link did not reproduce in this clean case.** The rehearsal's prior manual pairing/revoke/disconnect and Hub backup-restore history were not reproduced here, and no fix for that separate report is claimed. The initial probe's lazy imports crossed the test deadline while competing with type checks; loading the same member slices in `beforeAll` completed the probe without changing deadlines or product code.

There is no browser/pilot, real directory/account, daemon, tmux, native backend or model endpoint in these checks. `hub-company-join-restart.test.ts` constructs a second production FleetManager/controller over the same private files; it does not start or restart a Fleet process. UI tests prove the existing ended-state form with known/unknown outcomes; no screenshot or browser interaction acceptance is claimed.

## Compatibility and rollback

Old clients already understand `ended`, `expired`, `issued` and `outcomeKnown`; no new feature marker or import is needed. Unknown issuance still needs the existing exact recovery even after expiry. Reverting the code restores the old blocking behavior, with no data migration or file cleanup required. No live state was changed.
