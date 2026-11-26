# S-230 selected A: owner-control UI checkpoint

**DRAFT / USER LOOK HOLD. Production cutover assembly and full-mode proof are unfinished.** The user selected A (automatic after whole-Fleet readiness) on 11-26. Off means the capable bridge with fresh owner requests proceeding and outside requests awaiting explicit resolution; no rollback shadow, union propagation or old-rule restoration after activation.

[Selected plan and review mapping](../../design/request-context-cutover-s230.md) · [Picture hashes and individual source bindings](pictures.json) · [Verification](verification.json).

## Actual-app evidence

88 original PNGs: 11 states × desktop/phone × EN/zh-TW × light/dark. The real scratch FleetManager web listener, real host-session admission, Settings router/control API, Settings component, Needs-you renderer, SSE/history and General chat render these views. Source state is a synthetic owner status adapter: it does not install or activate the engine. No text is injected into the DOM. No Fleet, CLI, pane, provider/model/account session or live home starts. Agent-delivery and configuration-write fixture ports throw if reached.

States: on; Off after activation; Off before first activation; draining with Stop waiting; three initial readiness blockers; recovery after activation with Stop this work; Off confirmation; unconfirmed change; General notice. The older-version floor is explicit. Only never-activated blockers say existing rules continue. The recovery header avoids saying activation never happened.

The unconfirmed-result case deliberately changes only the fixture's status, then returns 503 through the actual API. The mounted UI shows that the result cannot be confirmed, disables another write, and offers a read to check. It sends no automatic repeat. The on case proves an older passive status cannot roll the switch back. The confirmation case sends no write before confirmation. New controls use a 44 px CSS minimum; screenshots alone are not hitbox measurements.

The General notice is the actual server-owned text helper sent through the real status-message SSE/history renderer. This proves its visible words and wrapping, not the future installer's durable once-per-epoch notification.

## Source bindings and bounded recaptures

- Full 80-frame matrix source: `5f1de4c0c672798786edb72dd76a8b2e967d3e45`; [receipt](capture-surfaces.json), 441 checks. (Ten states, eight variants.)
- Changed draining/readiness actions: `d67538c00faa587ed8ee10a562c45bdb1756d36c`; [receipt](capture-actions.json), 257 checks, 40 frames.
- Corrected recovery, on-state race and unknown-result cases: `aa43054b8ed27ba2369fff5c2ef1c8b3686c44cf`; [receipt](capture-unknown-result.json), 161 checks, 24 frames.

The final unique set retains 32 unchanged frames from each of the first two sources and 24 from the last. `pictures.json` binds each original to its source and SHA-256. The later changes add actions only to blocker views and change the recovery/error paths; the retained on/off/confirmation/notice output is unchanged. All 88 final originals were individually inspected by read-only image reviewers; no visual blocker or visible private value was found. The downloadable gallery embeds these exact PNG bytes; all 88 decoded hashes and local-browser image/filter rendering were checked.

Reproduce with private scratch homes only:

```sh
REPO=$PWD PW_DIR=$PWD OUT=$PWD/.artifacts/s230/look MATRIX=full npx --no-install tsx scripts/manual/request-context-cutover-s230/capture.mts
```

The final recipe supports `STATES=...` for bounded recaptures. It now includes all 11 states; the three retained receipts describe their exact earlier subsets.

## Implementation and limits

This checkpoint provides final-write input preparation, read-only whole-Fleet readiness proofs, current-process Fleet-lock capture, separate native execution lanes, staged-versus-installed daemon instruction checks, and owner-control API/UI boundaries with passive owner scoping. The production FleetManager still uses capability 0 and supplies no control/installation host. No automatic cutover can occur from this checkpoint.

Still required before formal completion: actual ingress/audience evidence adapters; all runtime/transport/drain owners; the atomic activation record and singleton publication; independent failed-install Off; concrete drain-resolution writers and outcome notices; conditional skill publication; full-mode, crash and rollback controls; prerequisite S-249/S-250 and final user lift. Never treat the status fixtures or this gallery as those proofs.
