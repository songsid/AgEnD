# Effect library Settings (#1629 B2)

`src/ui/settings-effects.js` is the human management surface for the session-only
`/ui/effects` API. `AppearanceSection` imports it as one card. It does not import
the effect runtime, create a frame/Worker, fetch effect code, or start a preview
listener. Saving a chat selection does not yet play it. Product mounting remains
blocked on the reviewed stock trust inventory and paint ordering.

## Contracts

- The catalog's `canWrite` is a display hint. The server still checks the current
  session, admin tier, CSRF/Origin and effect ownership for every write.
- Sharing/deletion controls are drawn only for the caller's own claim. Shared
  effects can be selected, but another person's claim cannot be changed here.
  Deletion still refuses references on the server.
- A folder contains `effect.json`, `worker.js`, optional host `poster.png` and
  `cursor.png`, and at most 16 raster assets under `assets/`. Picker paths lose
  only their common root. Unsupported or duplicate paths, missing entries, over
  20 files and over 8 MiB of raw bytes refuse before reading. The encoded body is
  bounded at 12 MiB. The server independently validates CW1 and its normalized
  1 MiB limit. Reading an effect never evaluates it.
- Saving uses an explicitly selected current chat and the values shown in the
  editor. It replaces that effect's parameter overrides, rather than pretending
  to edit a fetched current placement. Number/int/bool/enum/color values are
  checked locally; the server remains authoritative. Only non-default overrides
  are sent. Removing an effect uses the separate remove route.
- A synchronous operation claim prevents repeated same-turn writes. An abort
  signal and operation generation reject late file/fetch/confirmation results
  after the card is unmounted. This does not cancel a write the server has
  already accepted; a failed response can leave an uncertain result. Reload the
  library before deciding what to do next.
- Profile summaries/history are reported host observations, not measured effect
  cost or admission authority. Unavailable data remains unavailable. History is
  read only on demand. A catalog refresh discards cached history.
- Public links perform no effect-library reads or writes. Read-tier sessions see
  the library/history without mutation controls. Posters use the host's fixed
  image route; no manifest URL is navigated.

The approved five owner slots and their per-platform/explicit host-operator
identity, availability after unsharing, consent, safe mode and actual playback
will be connected in subsequent PRs. This card does not change preferences or
implicitly enable execution.

## Verification

`tests/settings-effects-1629.test.ts` renders the actual component through the
vendored Preact with the private mini DOM; its folder helper reads inert fixture
bytes. Server routes/library tests continue to enforce authorization independently.

After installing private Playwright tools, run:

```sh
PW_DIR=/path/to/private-tools OUT_DIR=.artifacts/settings-native \
  node scripts/manual/effect-settings-1629.mts
```

The recipe serves the real source module/styles from a scratch loopback server,
uses mocked catalog/write responses (not real authentication), and checks native
directory selection, exact Worker bytes without execution, typed apply, zero
frames/resource fetches, horizontal bounds, and the phone/coarse-pointer controls’ computed 16 px font floor while desktop sizing stays inherited. It records Chromium, Firefox and
Linux WebKit at EN/1366/light, zh-TW/390/dark, and EN/1366/coarse-pointer. Linux WebKit is not real Safari;
this is a card-level smoke, not a full-shell or product-runtime proof. It leaves
screenshots/receipts under the chosen output and removes its private browser HOME.
