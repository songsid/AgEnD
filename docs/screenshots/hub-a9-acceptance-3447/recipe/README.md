# Reproduction recipe and raw campaign ledger

These are QA-only copies, not production entry points. Use an owned detached worktree at the receipt's exact SHA and install its normal dependencies first. Never point these at an existing fleet/home/directory. All dummy identities and TLS peers are created by the rig. No native/model CLI is permitted: driver substitutes refusal executables and lifecycle methods, and browser requests are restricted to owned origins.

Copy `driver.mts` and `rig.ts` into `<worktree>/scripts/manual/a9-acceptance/`. For the base campaign use64dede51, for the delta923ccf98. The copied rig imports committed helpers from `tests/support`; it needs the normal `ldapts`/tsx dependencies. Launch in a clean environment:

```sh
REPO=<owned-worktree> ART=<owned-empty-artifact-dir> \
CANDIDATE=<exact-SHA> CANDIDATE_VERIFIED=1 \
PW_DIR=<private-playwright-prefix> CHROME=<owned-chromium-executable> \
FONTCONFIG_FILE=<private-fontconfig-with-CJK> \
node --import tsx scripts/manual/a9-acceptance/driver.mts
```

`CANDIDATE_VERIFIED=1` is a harness acknowledgement, not an authority bypass: the driver independently refuses a mismatched git HEAD. The original private fontconfig is included as an example; replace its absolute font/cache paths with your own. Browser uses no-sandbox and ignoreHTTPSerrors for this private certificate rig; neither is a production security recommendation or browser-sandbox certification.

The driver writes ready.json with only owned endpoints. Copy a single chosen segment to ART/command.mjs, wait for CONTROL_DONE/ERROR and its receipt before the next segment. `run2/command-N.mjs` and `delta/command-N.mjs` retain the chronological interactive ledger, including the explicitly documented failed fixture guesses. They are **not** a turnkey all-green test suite; use the receipt and final table to distinguish diagnostic segments, corrected positive paths and findings. Do not blindly replay contradictory setup or reuse the old absolute ART/REPO values. No route response replacement is used.

The final delta's command1 stopped after the wrong expected Start success wording; command2 continued the already-started state, verified actual listener/config, then ran the phone cycle. Command3 runs the setup access sanity; command4 guessed the wrong dummy admin name and made no changes; command5 corrects that name and checks shell pages. The final resource ledger is written before shutdown.

Touch ART/stop for awaited context, browser, FleetManager/HubRuntime/LDAP peer shutdown. Capture the owned PID descendants before stopping, then independently verify no live descendants, scratch roots absent and recorded ports bindable. Do not use broad kill patterns or host tmux. Cleanup receipts are under ../receipts.

Reload uses the committed `scripts/manual/smoke/smoke-hub-room-reload.mts` on64dede51; its receipt records32 checks/8 matrix cases and cleanup. `accept-a9.mts` is the quick-pair script copied from `scripts/manual/hub-quick-pairing/accept.mts`, adapted only for the new Notices navigation, revoke confirmation and screenshot-filter interaction. Place it alongside the original script so relative imports resolve; PROGRESS_FIX=1 LABEL_FIX=1 cover both regressions. Its receipt records47 checks/16 PNGs. Expiry is an injected clock, not a natural wait. The raw corrections/limits are also in the main README.

Only selected PNGs, non-secret receipts, public source hashes and QA code are retained here. No scratch databases, cookies, credentials, generated TLS private keys or initialized Hub homes are included. A targeted credential-pattern and JSON-field inspection found no token/private-key values. Dummy fixture passwords in rig.ts are synthetic; do not use them outside the rig.
