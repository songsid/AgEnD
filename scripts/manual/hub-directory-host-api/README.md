# D3 directory adapter verification

Run from the matching checkout, using its installed dependencies:

```sh
npx vitest run tests/hub-web-init-http.test.ts tests/hub-directory-settings-control.test.ts
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.test.json
python3 scripts/manual/hub-directory-host-api/verify.py
```

The last command changes one new adapter guard at a time and restores its source, including on failure. Do not run it concurrently with tests, type checks or source edits. An assertion failure is required for every selected reversal; a build/collection failure is not a passing result. Logs are private `.artifacts/hub-directory-host-api/` files. Evidence manifests use digest-first mappings, not token-like digest keys.

`hub-web-init-http` runs the actual fleet listener and D3 launch-session auth in a private home. Dispatch/refusal/cancellation cases use contract-faithful controller doubles. The outage case uses actual FleetManager, settings proof/writer, SQL, Runtime and CA-verified fake LDAPS wire: close the old peer; read the settings with D3; fail a candidate eligibility test without state change; restore eligibility; confirm the new endpoint's leaf; test and save. Only dummy service credentials reach the new peer; there is no Hub sign-in or browser session creation. All owned listeners/state are cleaned up.

This is backend-only: no new form, PNG, browser SKEW, real directory/account/pilot/native operation, or cold off/held source coverage is claimed. The previously mounted source remains locally valid despite the old directory's network outage. The off/held source path and form remain M-2687 work.
