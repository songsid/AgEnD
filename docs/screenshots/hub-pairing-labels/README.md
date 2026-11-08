# Hub pairing copy matches the fleet

This alpha.8 copy follow-up names the fleet's actual **Waiting for approval / 等待核准** card and **Hub address / Hub 位址** field in both Hub pairing flows. The administrator's copied handoff uses the same field label; the value remains the member-listener address, separate from the browser address.

| Run | Source | Checks | PNGs |
| --- | --- | ---: | ---: |
| [Before](before/) | `572e2abc0ab19a4cc12ea14bd4816bc4e0549707`, retaining `e7f425ff5` quick/owner words | 33 | 6 |
| [Current](current/) | `54e036d5c4e85362f43ba15ed9ff0fe905b21c6d`, clean alpha `a5de3040b` merge | 33 | 6 |
| [Cached shell/CSS](skew/) | same current source, retaining `e7f425ff5` app-shell and app/Hub CSS | 33 | 6 |

Each run covers desktop EN/light (1366×900) and phone zh-TW/dark (390×844), capturing quick code, fingerprint comparison, and the administrator's code card. Chromium `156.0.8078.4`; Noto Sans CJK TC. Phone quick-code captures omit the code value below the viewport, while the address label and paste instructions remain visible; fingerprint captures show the code and comparison controls. All eighteen PNGs were visually inspected for text wrapping, CJK, clipping and overflow.

The shared UI is unchanged: `QuickPairingGuide`'s `.hub-steps` and `HubAdminPage`'s `.hub-offer`, using existing field and note styles. Both flows remain in the Hub/fleet web pages with their existing confirmations; this patch adds no clicks, actions, CSS, routes, protocol or authority.

## Reproduction

Set `PW_DIR`, `CHROME` and a `FONTCONFIG_FILE` with Noto Sans CJK TC, then run from the checkout:

```sh
REPO="$PWD" OUT="$PWD/docs/screenshots/hub-pairing-labels/before" \
  LABEL_FIX=1 MODE=before-labels MATRIX=quick OLD_REF=e7f425ff5 \
  npx tsx scripts/manual/hub-quick-pairing/accept.mts
REPO="$PWD" OUT="$PWD/docs/screenshots/hub-pairing-labels/current" \
  LABEL_FIX=1 MATRIX=quick OLD_REF=e7f425ff5 \
  npx tsx scripts/manual/hub-quick-pairing/accept.mts
REPO="$PWD" OUT="$PWD/docs/screenshots/hub-pairing-labels/skew" \
  LABEL_FIX=1 SKEW=1 MATRIX=quick OLD_REF=e7f425ff5 \
  npx tsx scripts/manual/hub-quick-pairing/accept.mts
```

These are real isolated Hub HTTPS/WSS and fleet web listeners, production Settings confirmation and AD driver, with a recorded owned fake-LDAPS peer. The connector redirects requested loopback636 to that peer's ephemeral TLS port, retaining certificate verification and AD controls. Each case completes pairing through the UI and later revokes its owned fleet. No daemon/native CLI, account/model, live fleet or tmux operation. Scratch state, listeners and browsers are closed by the harness. JSON/log receipts stay local under `.artifacts/hub-labels/`.

## Validation

- Twelve new label-drift assertions fail before the copy change; all pass after. They compare both Hub string tables to the fleet's translated labels, rather than a second independent spelling.
- `npx vitest run tests/hub-pairing-labels.test.ts tests/hub-quick-pairing-ui.test.ts tests/hub-pairing-guidance-3386.test.ts tests/hub-owner-admin-c.test.ts tests/hub-continuation-3338.test.ts`: 69/69 across five files, zero skips, on aligned source `54e036d5c`.
- Both `npm run typecheck -- --pretty false` and `npm run typecheck:tests -- --pretty false` pass on the aligned source.
- `python3 scripts/manual/hub-pairing-labels/mutations.py`: six of six EN/zh address/card label reversals caught by failed assertions; original bytes restored. The clean alpha merge changed none of those files.
- Existing mounted administrator/clipboard controls pin the actual member address and code and refuse substitution of the browser origin.

Rollback: revert the two string-table edits and their label assertions. No stored state or migration.
