# CA settings API verification

Use the installed dependencies in this checkout. Focused commands are recorded in `docs/screenshots/hub-directory-settings-ca/checks.json`.

```sh
npx vitest run tests/hub-directory-settings-ca.test.ts tests/hub-directory-settings-control.test.ts tests/hub-directory-certificate.test.ts
npx vitest run tests/hub-compose.test.ts -t 'configured administrator AD settings HTTP'
npx vitest run tests/hub-web-init-http.test.ts -t 'routes CA|refuses other admin|a held factory|inspects CA without'
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.test.json
python3 scripts/manual/hub-directory-settings-ca/verify.py
```

The reversal runner changes one site at a time, requires assertion failures rather than collection/build/timeouts, and restores source in every path. Do not run it beside tests, types or source edits. Optional arguments select named rows. Private logs and JSON reports live under `.artifacts/hub-directory-settings-ca/`. Evidence uses digest-first maps.

The CA helper tests inject inert inspection/fetch and a recorded pool except the explicitly labelled real-wire journey. The real-wire journey uses the existing owned TLS/LDAP AIA fixture and dummy service credentials. It verifies no application bytes during inspection/pin refusal and only public CA data after ordinary verification. Socket-close tests intercept only owned client close events on their TLS class; the complete presented CA chain isolates each socket from LDAP-unbind ordering. Controller Stop tests use inert certificate functions and hold their physical promise. Listener tests use real Hub/fleet HTTP auth with contract-faithful controller doubles. No API response interception or real directory/account/native/pilot operation.

No editor, PNG, browser SKEW or cold off/held source acceptance is claimed. The existing Save trust proof is unchanged. See `docs/design/hub-directory-settings-ca.md` for the source/actor binding, errors and future single-dialog requirement.
