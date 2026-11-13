# Hub read deadline — M-3006 / #3761

A Hub GET could hold the serial queue forever while waiting for headers or its JSON body. Each admitted GET attempt now has a 120-second UI wait budget. Expiry aborts its transport, returns `unreachable`, and releases the queue without reloading or automatically retrying that timeout. Known setup steps and join-code rows remain visible with the existing Retry action.

## Scope and budget

- Alpha base: `719fb6f2c316de810e0cf86fcedc8851629d24ad`, after the published alpha.2 tag.
- Capture source and harness: `bf03ad0cd94e813ac1f8a03c32a8187aa868ee70`, clean tracked tree `1988b2ad95fbed9481e9fd3e559b316bf3d4911f`. Later packaging adds evidence and changelog fragments only.
- Three production UI files change. No server, directory admission, authority, workflow, stylesheet, string or write behavior changes. Existing cards, errors and Retry controls are reused, following `docs/design/ui-style-guide.md`.
- Ridge's source audit found no whole-route server deadline: 30 seconds bounds individual LDAP phases, while catalog reads may perform several serial proofs. The initial issue's proposed 30 seconds was therefore raised to 120 seconds. This is a finite **UI budget**, not a measured healthy-server maximum or a server completion guarantee. Catalog batching/paging would be separate work.
- Browser abort does not prove server LDAP work has drained. The server keeps its physical 4/person and 32/total ownership until close. A deliberate retry can still encounter backpressure; timeouts do not automatically replay. Existing bounded retries remain specific to HTTP 429 `backpressure`.

The timer starts when an admitted attempt begins running, covers both headers and body, and is cleared after completion. Caller abort and session retirement also abort owned controllers. Separate caller signals do not coalesce; signal-less identical pending reads still share one attempt. Late data and late 401 bodies cannot mutate the current session. Writes retain their original path and are never replayed by this deadline.

## Tests and reversals

`checks.json` records the commands and pinned input digests. Raw logs are gzip-compressed without changing their contents.

| Check | Result |
| --- | --- |
| Initial deadline fail-first, before implementation | 12 assertion failures and 2 passing controls; 14 tests at that stage |
| Timeout presentation fail-first, before the two UI guards | 2 assertion failures; 22 deliberately unselected |
| Final focused run, 15 files | 264/264 pass |
| Native source and test type checks | Both exit 0 |
| Ten isolated compiling reversals | All assertion-caught; no test timeouts; exact restoration |

`reversals.py` and `reversals.json` bind the ten checks: timer, actual transport abort, late body/401 fence, queue release, queued cancellation, session abort, backoff wake, controller cleanup, retained steps and retained code rows. Earlier logs retain their original smaller test-set scope. The final tests also pin the default/invalid-override 120-second budget, caller-signal isolation, pending-only coalescing, cleanup, no write deadline/replay, and refusal to accept server-supplied timeout metadata on an error response.

Run the focused suite with the command in `checks.json`; it uses `--maxWorkers=2`. Run native checks with:

```sh
node node_modules/@typescript/native/bin/tsc --noEmit
node node_modules/@typescript/native/bin/tsc --noEmit -p tsconfig.test.json
```

## Owned HTTPS browser rehearsal

`scripts/manual/hub-read-deadline-3761/browser.mts` serves the production Hub shell and client through an owned HTTPS listener, with recorded API DTOs. It stalls real HTTP responses before headers or during JSON bodies. The browser's 120000 ms timer is explicitly accelerated to 1000 ms; fake-clock tests separately pin the production default. This is not a 120-second elapsed-time or real-directory performance measurement.

The clean pinned run passed **11 cases / 117 checks**, producing **31 original PNGs** in `browser/`:

- Eight candidate cases: EN/zh-TW × light/dark × stalled headers/body, each with ready, timeout and recovered captures.
- Two controls retain the base `hub-client.js`: the original queue remains stuck and no Retry appears before context cleanup.
- One control retains the two base UI modules with the new client: the queue recovers, but the older code card drops its known rows on timeout; deliberate Retry restores it. This older-renderer limit is disclosed.

The candidate checks include physical stalled-socket close acknowledgement, the next queued read completing, no immediate timeout retry, retained known code, successful deliberate Retry, no overflow, no writes, no external requests and no browser errors. The receipt records exact Git inputs, served digests, retained substitutions and timer acceleration. Final cleanup reports `cleaned: true`, `remainingHeld: 0`, `remainingSockets: 0`; the process exited 0 and the browser slot was released.

No new named imports, CSS or server response requirement are introduced. A tab retaining the old client keeps the old stall behavior until reloaded. New client/old UI links and recovers with the presentation limitation above. No all-asset or all-browser SKEW claim is made.

The image-only check inspected exactly six still originals, listed in `visual-review.md`; it found no obvious overlap or horizontal clipping. Timeout messages move lower details/actions below the captured viewport. Static images do not prove interaction or transport behavior; the receipt and tests provide those checks.

Reproduce with an installed Chromium and Playwright core:

```sh
OUT="$PWD/.artifacts/hub-read-deadline-3761/browser" \
PW_DIR="/path/to/playwright-prefix" CHROME="/path/to/chrome" \
node --import tsx scripts/manual/hub-read-deadline-3761/browser.mts
```

The rig uses a disposable home, an owned listener and inert API data. No real account, AD, Fleet, pilot, CLI or native service was used. Physical HTTP close is proved; server LDAP/session drain is not claimed.

## Risk and rollback

A supported but unusually slow catalog can exceed the UI budget and require deliberate Retry; the budget is fixed rather than enlarged by row count. Queued reads start their own timer only when admitted. Rollback is to revert this PR; that restores the original unbounded-read behavior. No stored data or protocol migration is involved.

`manifest.json` is digest-first: every listed path resolves relative to this directory. It excludes itself and this README to avoid circular/self-changing digests.
