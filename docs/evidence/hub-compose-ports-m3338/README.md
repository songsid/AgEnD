# Compose fixture listener reservations (M-3338)

The original compose fixture selected member and web ports with two
sequential `freeHubPort()` calls (`tests/hub-compose-rig.test.ts:82` at
base `377221bf`). That helper closes its bound socket before returning
(`tests/helpers/hub-rig.ts:15–17`), so the second call can receive the same
address. CI run 44319424526, attempt 1, failed with both distinct-address
checks in `HubInitError`; `ci-before.txt` retains that small excerpt.

`hubComposePorts()` now gets both ports from the existing, unchanged
`hubListenerPorts()` lease helper. The first socket stays bound while
the second is selected, so the kernel cannot give the second listener
the same address. Both stay bound through initialization; each real
TLS listener adopts its own bound handle. Teardown closes both leases
and restores the fixture spies. No port retry or timeout change is used.
Production code and the Hub address checks are unchanged.

The old two-call expression was first extracted without changing its
behavior. A test then forced the legacy picker to return 31337 twice:
the distinctness assertion failed. After the lease change, both tests
pass. They also attempt real competing binds and complete trusted-TLS
requests through the adopted member and web sockets. Restoring the old
two-call body makes the selected regression fail again; exact restoration
returns both tests to green. Test TypeScript has zero diagnostics.

The actual `hub-compose-rig.test.ts` flow passed locally, one test with
zero skips, against an owned disposable fake directory. It exercised
initialization, runtime mount, sign-in, admin overview and the next-request
refusal after disabling that test owner. The container and its generated
credentials were removed. No live Fleet or real directory was touched.
The full CI `hub-directory` result is a separate required check.

Validation and separate path/hash records are in `validation.json` and
`manifest.json`. Raw container environment, credentials and full CI logs
remain private. Rollback reverts this test helper, consumer and regression
tests; it changes no product setting or stored data.
