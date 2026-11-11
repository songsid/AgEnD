# Desktop split chat, PR1: ownership

Original R0 source/capture head: `5bf0bbb174ca409a36f1f9060a5be4a6c7ebe007`.
Control: alpha `996e3e201e39d70e0d892c8420a169d9eb4e1eb6`.
Approved design: `docs/design/desktop-split-chat.md`, copied unchanged from `d6735f99`.

The first of four slices prepares pane ownership. Each mounted chat has its own composer refs and palette IDs, a focus registration, and cache protection. A stream gap recovers every visible chat. Preview and image cleanup belongs to the opening chat. Details guards coexist; every lazy outlet follows the shared import. Chat, View, Log and Settings accept an optional DOM-free pane scope while their legacy defaults remain in use.

The existing single-pane render path, labels, styles and page stream stay in place. PR2 supplies the two-pane host, local category/back-link routing, shared form-control ID scoping, focused page controls and capability gates before offering the feature. Dragging/float and pop-out follow in PR3/4. No backend, authentication or persisted data format changes.

## Tests

- Initial new test file on the original alpha control: **7 fail / 1 legacy control pass**. An additional held-history/abort control fails before the request-generation guard.
- Pre-sync related coverage: 756/757 in 20 files; the remaining delivery test hit its unchanged 10-second FleetManager import deadline. The same file passes 52/52 in isolation. Earlier unbounded parallel coverage also hit two beforeAll deadlines; logs are retained locally, and are not counted as passes.
- Latest ownership/Chat/Details control before sync: 60/60. After merging the composer-width change: **245/245** in ownership, Chat C1, image-lightbox and Hub chat.
- Final pinned module-skew/i18n/quiet-chat/panel checks plus C3: 100/101; the same backend-import deadline occurred. All six other files pass; the same post-sync C3 file then passes **52/52** in isolation (14.51 seconds total, unchanged timeout/assertions). No timeout or assertion was changed for that test.
- **13 compiling semantic reversals**, one at a time, each produces an assertion failure: visible histories, visible prompts, focused-owner cleanup, mounted cache protection, title focus, Escape focus, composer lookup, preview cleanup, image host, Details guards, history generation, lazy subscribers and composer IDs. `mutations.json` binds the exact source bytes; every file is restored after each run.
- Native source/test type checks and changelog validation pass. No test or browser run starts a real agent CLI.

Commands (from the candidate worktree):

```sh
npx vitest run --maxWorkers=2 tests/web-chat-pane-ownership-3637.test.ts tests/web-chat-c1.test.ts tests/chat-image-lightbox.test.ts tests/hub-chat-b.test.ts
node node_modules/@typescript/native/bin/tsc --noEmit
node node_modules/@typescript/native/bin/tsc --noEmit -p tsconfig.test.json
node scripts/changelog-assemble.mjs --check
python3 docs/evidence/desktop-split-chat-pr1/mutate.py
```

The mutation runner writes to `.artifacts/split-chat-ownership`; create that output directory first. Its selected tests use the existing production mini-DOM harness.

## Browser evidence

`smoke-split-chat-ownership-3637.mts` boots the real FleetManager web listener in a new scratch home and signs in through the real form. It records the clean Git head/tree, input hashes, served bodies, substitutions and final unchanged-source check. Receipt hashes use digest-first maps. Host theme/language preferences and overlay dismissals are seeded, so these are controlled parity cases.

| Folder | Cases | Scope |
| --- | ---: | --- |
| `control/` | 20 | Clean alpha control: zh-TW desktop/phone, light/dark, Chat idle/working, View, Log, Settings |
| `current/` | 20 | Clean candidate, same cases |
| `old-shell/` | 10 | Candidate with exact retained control app-shell, app-nav, app-ctx and app.css; desktop light/dark |
| `old-chat/` | 10 | Candidate with exact retained control Chat, store, composer, text tabs and image host; desktop light/dark |

A built-in visual audit inspected all 60 original PNGs. Idle Chat matches control pixel-for-pixel in all four device/theme cases; phone View also matches. Remaining screenshot differences are status pixels and the isolated temporary-directory value.

All 60 cases have one header, no page overflow, one active browser EventSource and one server-side SSE client throughout in-page tab changes. All **20 control/candidate geometry comparisons match exactly**, including the working bar after the incoming composer-width fix. Every declared retained asset was requested and its digest is recorded. A closed context ends its listener before the next case.

The fixture substitutes only its own terminal text/size endpoint and steps response, and supplies a usage fetcher before any page opens. A browser tripwire refuses external origins. This proves real app rendering and lifecycle; it does not prove terminal/transcript backends, a vendor account, the live Fleet, a real directory or native runtime. No HTML preview is executed in the browser run; existing preview lifecycle tests cover it. The temporary directory shown on Settings differs between isolated runs. Task-board unavailability is identical in these fixture screenshots.

Representative requested originals:

- `control/desk-light-zh-TW-chat.png` → `current/desk-light-zh-TW-chat.png`
- `control/desk-dark-zh-TW-chat.png` → `current/desk-dark-zh-TW-chat.png`
- `current/desk-light-zh-TW-chat-working.png`
- `current/desk-dark-zh-TW-details.png`

Example capture:

```sh
REPO="$PWD" PW_DIR=/path/to/playwright-prefix OUT="$PWD/.artifacts/split-chat-ownership/current" \
  MATRIX=desk-light-zh-TW,desk-dark-zh-TW,phone-light-zh-TW,phone-dark-zh-TW \
  MODE=current BASELINE_REF=996e3e201e39d70e0d892c8420a169d9eb4e1eb6 HP=54970 \
  npx --no-install tsx scripts/manual/smoke/smoke-split-chat-ownership-3637.mts
```

Merge sync: a plain merge of alpha `996e3e201` resolved one conflict in the shared composer. It retains the incoming Stop-in-working-bar behavior and adds optional scoped IDs with unchanged default IDs. There was no rebase or force-push.

Risk/rollback: the main risk is an ownership cleanup regression. The focused, repeated-mount, retained-asset and Hub controls cover these boundaries. Reverting this PR restores the previous client modules; it needs no data migration. Later slices remain dependent on the ownership capability checks.

## R1: accepted discard survives the other pane's decision

The review found that accepting A's discard cleared only its guard ref. If B's question kept the page mounted, a parent/status rerender could restore A's old staged state and queue a third confirmation. The fix clears the ref and state to the same empty map and resets A's forms. If B cancels, A stays discarded and B keeps its own edits; if B accepts, navigation completes after exactly those two decisions. The reset does not save settings or add a confirmation step.

R1 source/capture pin: `fa9788aa1fcdc964322435b3dec5865deac45ff3`. Only `agent-details-settings.js` and the ownership tests changed from R0. Two new mounted-hook controls first fail semantically on R0 (both accept, and B cancels after the forced rerender). The corrected four suites pass **70/70**, then the restored ownership suite passes **16/16**. Reversing coherent state clearing or the form-reset epoch each causes a real assertion failure; both restore exactly. Native source/test types pass.

`r1-current/` is a fresh clean-source desktop zh-TW light/dark capture: ten cases at the new source pin. All ten geometries match the corresponding original candidate cases. It retains one browser/server stream, no overflow and no external browser request. The original sixty PNGs/receipts and original mutation execution remain on their original pins; they are not relabelled as R1 runs. This is a state-only correction, with no new visual design or PR2 host.
