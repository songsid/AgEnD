# Normal-request credential status evidence

Base: `2561cb29b`. Synthetic fixtures only; no real credential, provider/model request, native account login or live Fleet/pane was used.

## Fail first

In a disposable checkout of the base, `git apply docs/evidence/claude-credential-verification-m3419/base-control.patch` adds one real monitor → daemon → published Fleet → encrypted vault control. Run `node node_modules/.bin/vitest run tests/claude-credential-observation-base-control.test.ts`. It fails semantically: expected verified with a timestamp, received saved-unverified. The current full observation suite contains the same positive path and the refusal controls. No raw provider output or private test logs are published.

## Tests and reversals

The affected request/launch/vault/transcript/UI suites passed 82 tests; six model/lifecycle/skill/process neighbors passed 57 tests before the final combined check. The final combined affected/neighbor/ratchet run passes 233 tests across 14 files. Final commands are recorded in the PR acceptance. Source and test TypeScript checks passed.

Four deliberate removals are caught: revision equality (including no audit mutation for stale evidence), session-hook equality, current local source proof, and current published-daemon ownership. The first revision reversal exposed a missing no-audit assertion; that assertion is now in all negative controls and the reversal is red. Every reversal was restored before final checks. These are bounded synthetic controls, not a provider/native compatibility claim.

## Real-app captures

`capture.mts` boots the actual Fleet web server in a fresh synthetic home, never starts the Fleet, and seeds the real vault metadata. Chromium runs headless inside a scratch network namespace with only loopback. Catalog/usage responses are bounded fixtures; no credentials are entered into the page. Run with the existing smoke-fixture environment (`REPO`, `PW_DIR`, `CHROME`, `OUT`, and a CJK-capable `FONTCONFIG_FILE`), for example `node --import tsx docs/evidence/claude-credential-verification-m3419/capture.mts`. The launcher must create the isolated network namespace first.

The eight device/theme/language cases each show saved (before), verified/time, auth-error and unknown. `capture-results.json` records 32 screens with zero page errors, CSP violations, horizontal overflow, undersized active phone targets or visible fixture values. An image-only check read 12 representative originals; the final phone zh-TW verified and auth-error originals were rechecked after the badge-color correction. No secret, private identity or production evidence appears.

## Scope and rollback

This observes fresh completed local Claude records under their launch/session and source binding. A successful local auth-source probe is never used as provider acceptance. Missing native evidence stays unverified. Source/credential changes invalidate prior proof. Opaque organization policy and same-OS-user isolation remain unsupported.

Rollback removes observation/status rendering and preserves the encrypted vault/key. Earlier binaries ignore the additive metadata table; id/revision matching prevents an old stamp applying to a later credential. Metadata failures do not interrupt ordinary work or select a fallback.

The user reported two zh-TW typography ambiguities. Source and image checks found no duplicated character or literal padded parentheses. The redundant profile parenthesis was removed and the hint now says `錯誤碼：401/403`; all 16 zh-TW views were regenerated.
