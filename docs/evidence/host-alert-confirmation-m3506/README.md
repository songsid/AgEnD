# Host-alert confirmed Settings save (M-3506)

At base `db01bd20`, an admin's Host alert settings save was proposed and confirmed, but failed with `apply_rejected: admin_session_required`. Confirmation replay deliberately omits credentials. The handler incorrectly demanded a session cookie again, although the confirmation already owns a current original-admin capability.

The PUT handler now accepts the server-owned Settings execution's local-admin capability, including its current-principal, confirmation and baseline fences. The existing `settingsWrite` commit remains. Direct requests and GET still require the same current admin session. A client header token does not create that capability. No UI, collector or notification behavior changes.

## Regression and checks

The new five-case test uses the actual HTTP confirmation, store, baseline reader, request handler, session authorizer and atomic sidecar writer. On the unchanged base it fails the positive confirmed-apply case (1 failed, 4 passed). With the fix, 93 tests across five affected confirmation/alert suites pass. The final test-only type correction uses `Object.assign` to simulate principal demotion; its five cases pass again. Production/test types and build pass. Commands and counts are in `checks.json`.

The positive case requires session PUT → 202 → confirm → sidecar → authenticated GET, verifies mode 0600 and unchanged YAML, and refuses a second confirmation. Negative controls cover read sessions (direct and confirmed), header-token substitution, principal demotion and stale sidecar baselines.

## Real-app read-back

`readback.json` records a Chromium run against the real Settings page, server, session authentication, confirmation gate and FleetManager writer in a scratch fixture. It changes General to on and CPU warning to 91, clicks Save, observes 202, confirms through the store, verifies GET and the actual sidecar, then reloads the page and verifies both controls. No save/read-back endpoint is mocked. The fixture disables automatic self-confirmation to exercise the held replay. Only capability availability is exposed to render Settings; monitoring remains off throughout, so no collector or alert delivery runs. The synthetic fixture has no account/model/CLI or live Fleet. Browser, listeners and scratch state closed successfully.

The first manual attempt used an old button label (“Apply changes” instead of the current “Save”) and never submitted a write; the corrected locator produced the recorded successful run. No captures are needed because no UI changed.

## Risk and rollback

Scope is one route's authorization during confirmed PUT. Existing authentication/CSRF and transaction fences remain in force. Revert the change to restore the former behavior; that also restores the save failure. Stored sidecars and schema are unchanged. This is the authorized beta.18 freeze exception; the coordinator alone gates and merges after exact-head approval and green CI.

## Scanner evidence correction

The pinned Gitleaks 8.24.3 scan reproduced one `generic-api-key` false positive at the old manifest line 2: a source path containing `api` was the JSON key directly beside its SHA256 digest. The test token was not the finding. The manifest now separates path and SHA256 fields in records; production, test and manual-app inputs are unchanged. No scanner allowlist was added. Because CI scans every reachable PR commit, the owned single-commit branch was amended to remove the flagged historical evidence representation. The old head remains historical evidence only.

Pinned local scanner: the original one-commit range reproduces one finding; the corrected one-commit range scans clean (no allowlist). This is a direct linear-range scan, not a claim that the complete CI wrapper ran locally: the shared checkout is shallow and Git 2.34.1 lacks `--diff-merges=remerge`. Terminal CI remains required. All production/test/manual inputs are byte-identical to the initial head; prior runtime and real-app evidence carries without repetition.
