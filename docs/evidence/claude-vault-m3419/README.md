# Managed Claude storage evidence

This is the storage/API foundation only. It does not launch Claude or offer the new dashboard selector.

- Five focused files (vault, HTTP route, Accounts removal/sign-in and skill sync): 45 assertions passed. The subsequent narrow lifecycle delta added the cancellation interleaving; HTTP + Accounts removal passed 34 assertions.
- `node node_modules/.bin/tsc --noEmit` and `node node_modules/.bin/tsc --noEmit -p tsconfig.test.json`: both exit 0 after that delta.
- Six reversals were each caught by an actual assertion failure, not a transform/build failure: remove revision CAS; remove AAD on both seal/open; remove the credential/audit transaction; remove gateway refusal; admit an unverified actor; reuse the initial actor instead of rechecking after the body.
- Storage controls cover ciphertext-only disk content, metadata-only output, separate private key, restart, two-connection CAS, deletion tombstones, audit-trigger rollback, AAD bindings for kind/id/revision/profile, wrong/lost keys, symlink/permission/inode refusal and bounded audit retention.
- HTTP uses real loopback sockets with synthetic sessions and a controlled verified-actor port. Positive save/replace/remove runs the real vault. Negative cases cover unverified/read/guest/header/public/forwarded/CSRF admission, revocation while the body is held, strict bounded bodies, safe errors, profile existence/in-use and concurrent cancellation/removal.
- No real account, real credential, external provider call, paid/model call, browser, live Fleet, Windows window or host configuration change. All credentials are generated synthetic test strings. Test logs and private scratch state are not published.

Rollback: remove the new API composition and retain the encrypted database plus separate key. Do not delete stored data or migrate it to plaintext. Existing subscription-login behavior is unchanged; the later launch/UI slices are separately reviewed.

The endpoint was moved to the independent `/ui/claude-credentials` namespace to preserve the legacy DELETE route for a profile literally named `credential`. The eight HTTP tests pass after this narrow delta; restoring the colliding endpoint makes the new legacy-route assertion fail. The website slice targets main and stays on HOLD until the feature ships in beta.
