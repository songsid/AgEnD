# Hub pairing progress (#3403, #3404)

Browser source: `37e21c083981ca8508d862084ba8e848bb16122a`, based on alpha `f61e3608cdf888396474a99d1c76f766c8bf314f`. Chromium `156.0.8078.4`; desktop 1366×900 and phone 390×844.

| Run | Matrix | Checks | PNGs |
| --- | --- | ---: | ---: |
| [Before](before/) | desktop/phone × EN light / zh-TW dark; retains f61 pairing UI modules | 65 | 8 |
| [Current](current/) | same four cases | 65 | 8 |
| [Cached shell/CSS](skew/) | desktop EN light, phone zh-TW dark; retains f61 app-shell and app/Hub CSS | 35 | 4 |

Each case captures `local-step` after accepting the code but before fleet-local fingerprint confirmation, then `expired-confirmation` after the exact local Settings proposal fails. Before, the local step has a premature green check and the local card keeps waiting. Current and cached-CSS shots show the pending numbered step and a plain failure with the new-code next step. The global failed proposal card is above the phone viewport; the phone PNG proves the inline message, while browser assertions and desktop PNGs also establish the global failure.

## Boundary and expiry

The smoke runs real isolated sealed Hub HTTPS/WSS and a fleet web listener with production Settings confirmation and member pairing routes. The production AD driver talks to an owned recorded fake-LDAPS TLS/BER peer; only its connector redirects the requested loopback 636 socket to that peer's ephemeral port, retaining TLS verification and AD controls. A host-loopback session applies the real Settings proposal. Each case first completes a successful pairing, then checks the expired-code failure with no saved pairing credential.

The Hub/member **injected test clock** advances past the unchanged ten-minute TTL. Browser and Settings clocks are unchanged. This is not a natural elapsed-time claim; [Sentinel's #3395 acceptance](https://github.com/songsid/AgEnD/issues/3395) separately demonstrated natural expiry. The browser records actual Hub `410` responses in all six current/cached cases. No daemon/native CLI, Windows, account, model, live fleet or tmux operation is exercised. Owned listeners, browser contexts and private scratch state are closed by the harness.

## Reproduction and validation

From the checkout, set `PW_DIR`, `CHROME` and a `FONTCONFIG_FILE` with Noto Sans CJK TC available, then run:

```sh
REPO="$PWD" OUT="$PWD/docs/screenshots/hub-pairing-progress/before" \
  PROGRESS_FIX=1 MODE=before-progress OLD_REF=f61e3608c \
  MATRIX=desk-light-en,desk-dark-zh-TW,phone-light-en,phone-dark-zh-TW \
  npx tsx scripts/manual/hub-quick-pairing/accept.mts
REPO="$PWD" OUT="$PWD/docs/screenshots/hub-pairing-progress/current" \
  PROGRESS_FIX=1 OLD_REF=f61e3608c \
  MATRIX=desk-light-en,desk-dark-zh-TW,phone-light-en,phone-dark-zh-TW \
  npx tsx scripts/manual/hub-quick-pairing/accept.mts
REPO="$PWD" OUT="$PWD/docs/screenshots/hub-pairing-progress/skew" \
  PROGRESS_FIX=1 SKEW=1 MATRIX=quick OLD_REF=f61e3608c \
  npx tsx scripts/manual/hub-quick-pairing/accept.mts
```

- Fail-first: ten failed assertions before implementation, with twenty passing controls.
- Focused validation: 151/151 tests across eleven files, zero skips; both `npm run typecheck -- --pretty false` and `npm run typecheck:tests -- --pretty false` pass.
- `python3 scripts/manual/hub-pairing-progress/mutations.py`: eight of eight reversals caught by failed assertions, including settlement observation, both asynchronous stale-result fences, failure/unknown copy, local proof and pinned-link waiting.
- Raw browser/test/mutation receipts remain local under `.artifacts/pairing-progress/`; only PNGs and this description are committed.

This patch changes browser progress presentation only. It adds no server route, credential, wire field, schema or authority. A cached older member-client module without the additive settlement Promise retains the prior projection-based fallback; the cached-shell/CSS run uses current pairing modules. Rollback is a revert of the UI patch.
