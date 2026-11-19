# Pilot trust: unknown-CA regression

M-3097 pins the existing self-signed-only pilot exception. The old suite covered self-signed, wrong-name, expired and mismatched-pin cases but did not distinguish an otherwise valid leaf issued by an untrusted CA. Production code is unchanged.

The extended owned HTTPS fixture generates the CA and leaf at test time, resolves its reserved example hostname only to loopback, and keeps its web certificate separate from the pinned member identity. Cleanup closes its listener/controller and deletes both disposable homes and generated certificates. No operator trust store, real Hub, directory, browser, account, vendor CLI or model is used.

Three new cases assert that a correctly named CA-issued leaf offers no pilot-trust candidate, and that an exact-fingerprint explicit choice or forged saved pin cannot start joining. Refusal precedes HTTP metadata, push commands, identity pins and join journals. A positive control reads the same listener using its configured CA through ordinary TLS validation, proving the certificate name, dates and metadata are otherwise valid.

## Validation

- `node_modules/.bin/vitest run tests/hub-company-pilot-trust.test.ts --maxWorkers=2`: 15/15 pass, including the three new cases and existing self-signed controls.
- `node_modules/.bin/tsc --noEmit -p tsconfig.test.json`: exit 0.
- Removing only the self-signed guard in `inspectPilotCertificate` makes all three new negative cases fail with assertions. The guard is restored byte-for-byte, and `git diff --exit-code -- src` is clean. `control.json` records the result. The redacted diagnostic replaces generated fingerprints, operation IDs and the local worktree path; they are not real account or host data.

This is a test-only follow-up, not a newly discovered production bypass. No package-visible behavior changes and no changelog fragment is needed under docs/development.md. Rollback removes these tests/evidence; runtime code, trust policy and saved user data are unchanged.
