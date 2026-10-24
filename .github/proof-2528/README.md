# #2528 synthetic fail (throwaway)

DO NOT MERGE. Close after the three CI gates have failed on the draft PR.

1. Unpinned action: `.github/workflows/_2528-proof-unpinned.yml` uses `actions/checkout@v4`.
2. Vulnerable dependency: `@babel/traverse@7.23.0` (GHSA-67hx-6x53-jw92, critical).
3. Bad signature: stub `bin/npm` reports `EINTEGRITYSIGNATURE`; `npm-audit-signatures.yml` puts it first on PATH.
