# Stopped/held directory settings verification

Use this checkout's installed dependencies. Full focused verification:

```sh
npx vitest run tests/hub-directory-settings-decision.test.ts tests/hub-compose.test.ts tests/hub-web-init-http.test.ts tests/hub-settings-fleet-m2682.test.ts tests/hub-health.test.ts tests/hub-directory-save.test.ts
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.test.json
```

The small addendum targets `cold settings source|local directory settings while off or held` in decision and compose. The existing D3 wire case targets `replaces an unreachable AD` in web-init-http; its two modes are running and off. Those use a real fake LDAPS peer and actual private HTTP requests, not browser API-response interception. The old peer is closed before recovery. The remaining source, runtime and FleetManager cases use explicitly identified inert directory/runtime doubles; SQLite, seals, version floors and the compose listeners are real owned fixtures.

`python3 scripts/manual/hub-directory-cold-settings/verify.py` reverses one named guard at a time, requires assertion failures and restores every source byte. Optional arguments select names. Do not run it beside tests, typechecks or source edits. Reports stay under `.artifacts/hub-directory-cold-settings/`; committed evidence is digest-first.

No form/PNG/browser SKEW, real directory/account, native/pilot/live operation or full Stop/reinitialization claim beyond the specified runtime controls. See `docs/design/hub-directory-cold-settings.md`.
