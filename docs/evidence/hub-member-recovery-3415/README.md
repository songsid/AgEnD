# Hub member recovery — #3415 (alpha)

A Hub restored to an older state can no longer recognise a later member credential. Previously the machine listener closed the failed handshake silently, the member projected it as offline, and startup cleanup could erase a more useful hold. Settings offered no recovery action for that saved connection.

The pinned listener now returns a bodyless 403 for an authentication refusal. The member distinguishes pinned 401/403 from outages, retains a bounded `rejected` hold through startup cleanup, and scopes that diagnostic to the exact saved profile digest. An invalid protocol exchange uses the same generic recovery explanation. An explicit live revoke keeps its distinct reason. 429/503 and temporary disconnects remain outages and retain normal reconnection.

Settings offers **Pair again** for refused/revoked exact bindings. It uses the existing confirmed Disconnect, then Start over, then the existing company/manual pairing controls. No endpoint, credential authority, fingerprint acceptance or automatic retry of agent input is added. A silent older Hub remains offline: conditional copy explains automatic outage recovery and offers Pair again without claiming that a restore was detected.

## Evidence and limits

- `fail-first.json`: detached baseline product **9a351611bea1363ce7248c5954876b9c2e6685de**, with only the two regression test files copied from **c604ae782**. Three selected tests fail at the intended assertions: restored later member remains paired; EN/zh explanations are generic. No product mutation on this baseline.
- `tests/hub-member-restore-3415.test.ts`: owned stopped SQLite backup plus matching transport floor, later member credential, actual restored Hub pairing/listener and production member composition over pinned HTTPS/WSS. Exact Disconnect/Cancel, normal owner/admin and fingerprint confirmations, fresh credential and online recovery. Controls cover live revoke, automatic outage reconnect without profile changes, pinned 401/403 versus 429/503, invalid frames, late cancelled opening, and stale-profile diagnostic isolation. It models the transport state, not an old-binary migration or full initialization restore.
- `checks.json`: **293/293** in 14 focused files, source/test types pass; no local full-suite claim. `mutations.json`: **10/10** individual reversals produce semantic assertion failures, with byte-exact restoration. Mutation tests used the original **1f09ad59f** test source; the subsequent spy edit changes only its TypeScript annotation, and product blobs match the captured source.
- `browser-receipt.json`: clean committed source/harness **c604ae782**, tree and relative input digests, actual served response digests and exact retained substitutions. Product files and harness remain identical at the evidence commit. No historical modified-tree capture is relabelled.
- **36 display cases / 268 checks / 40 PNGs**: real app.html, cookie sign-in, sidebar and Settings → Hub menu; desktop 1366×900 / phone 390×844, EN/zh-TW, light/dark. Eight each of before/offline/rejected/revoked, plus four retained controls. Phone-light EN/zh exercise the existing confirmation, exact binding Disconnect, Cancel and the Advanced pairing form. Source stayed immutable during capture; fixture contexts/listeners/scratch homes closed.
- These browser cases use explicit member/membership view and step HTTP fixtures, not a restored backend. The backend and authority claims come from the separate real SQLite/TLS test. No real directory/account, model, daemon, native runtime or live fleet was used. Chromium 1248 / Playwright 1.64.1 and checksum-pinned Noto CJK font preparation from M-2822 were reused.
- SKEW: candidate JS with baseline strings, client or app.css; baseline manual UI with new held projection. Old strings use the existing refusal wording; old UI shows generic hold/Start over and needs refreshed assets for the new action. No cached module is given extra authority. Older-Hub silent failure is a display fixture plus real transient/HTTP refusal controls, not an old binary execution.
- Visual review inspected all eight rejected originals, both phone-light confirmation/ready views and four retained controls; no unresolved defect. The Advanced form's lower fields are below these viewport captures and were not visually assessed. Browser visibility assertions cover the form.

Representative images: [EN before](screenshots/desk-light-en-before.png), [EN rejected](screenshots/desk-light-en-rejected.png), [zh-TW phone rejected](screenshots/phone-light-zh-TW-rejected.png), [confirmation](screenshots/phone-light-zh-TW-rejected-confirm.png), [silent offline](screenshots/phone-dark-zh-TW-offline.png). `manifest.json` maps digest first to every evidence/source input path.

## Reproduce

```sh
npx vitest run tests/hub-member-restore-3415.test.ts tests/hub-member-held-ui-3415.test.ts
npm run typecheck
npm run typecheck:tests
# Use your own Playwright-core directory, matching Chromium, CJK Fontconfig and short TMPDIR.
REPO="$PWD" OUT="$PWD/.artifacts/recovery-browser" MATRIX=full \
  PW_DIR="$OWN_PLAYWRIGHT" CHROME="$OWN_CHROMIUM" FONTCONFIG_FILE="$OWN_FONTS" \
  HOME="$OWN_EMPTY_HOME" TMPDIR="$OWN_SHORT_TMP" \
  npx tsx scripts/manual/hub-member-recovery-3415.mts
```

Commit source and harness before capture: the runner refuses tracked modifications, checks its inputs at the end, and records exact substitutions from the baseline git object. A preliminary launch refused a long Chromium socket path; a preliminary full display run expected the Advanced form to be visible before opening it. Those incomplete diagnostics are not included or claimed as passes. The final clean pinned run above succeeds.

## Risk and rollback

Authentication refusal stops retrying that credential until the existing pairing flow replaces it. A generic refusal cannot establish the cause; copy deliberately says “may have been restored”. Silent older peers keep reconnecting and show conditional guidance. No data format or stored pairing schema changes: revert this PR to restore previous transport status/UI behavior; do not restore or edit member credentials.
