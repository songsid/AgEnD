# Desktop split chat — PR2 (#3637)

桌面可同時開兩個不同 Agent，左右或上下排列；每格沿用原有文字分頁。一般側欄點擊換目前窗格，文字可引用到另一格草稿，不會送出。窄畫面一次只顯示一格，以 Agent 分頁切換。拖曳、分隔線、頁內浮窗及真正 pop-out 依已同意設計留在 PR3／PR4，本 PR 不顯示未完成入口。

The existing app router, stream, chat store, preview slot and Settings runner retain ownership. The new host mounts two complete existing panels. It does not start an agent or grant authority. Single-pane IDs and resting geometry retain their defaults. Entering/leaving a workspace cannot silently discard an unsaved Settings form: the existing discard guard runs before the remount. Compact suspension unmounts hidden readers while retaining each Settings form and its leave guard in pane-owned memory; it never stores typed values in localStorage.

## Plain alpha sync after approval

Merged alpha **ec9a119e6102577cdecf2702ff01991ef3231a3c** with a normal two-parent merge, **3bfa962766958314ef58e73a799b75c333486dc3**. One manual conflict in ClassicFields combined the incoming account selector/model-profile handoff with pane-scoped IDs. Its new per-CLI account draft uses the existing pane-memory hook so compact suspension retains choices. The default single form keeps local state. No rebase or force push.

The 73 incoming paths have four overlaps: agent-details-settings.js (the Classic runtime category adds backend_options), settings-dialogs.js (the resolved picker), app.css (an incoming Office textarea selector) and web-api.ts (incoming Office endpoints, retaining the existing split-chat marks). All 69 disjoint incoming paths are byte-identical to alpha. The approved R2 recovery function, pre-Classic forms/emoji code, workspace host/navigation and runner are byte-identical to the approved head. Incoming EOF blank-line warnings in three unrelated Hub files remain unchanged; the own diff against alpha passes whitespace checks.

Seven related suites pass **53/53**; the final field suite passes **5/5** after three compiling guard reversals restore exact source. The related run predates only a mock-call reset and positive loop-count assertion in the new control. The reversals catch lost per-CLI draft memory (one semantic failure), an unscoped account ID, and missing ModelSelect profile. The control checks two panes, separate CLI choices, remount, default reset and a passive model read with the selected profile. Both native typechecks and **386** fragments pass. Runner/endpoints and the earlier recovery decisions are unchanged by the resolution.

New clean source captures at the merge commit add **34** light/dark checkpoints plus **2** retained-fields controls: geometry, Settings suspension, unfocused Alt-Split, ordinary deep links and narrow fallback; one stream and no page errors/external requests. They retain their own source/tree/input/served-asset receipts. Eight selected originals have no blocking static visual finding. The browser fixture has no Classic rooms, so it does not claim visual account-picker coverage; that behavior is proved by inert actual-form tests. Prior PNGs and historical timestamp/glyph/SKEW scopes are unchanged. Resolution audit, inputs and outputs are under `checks/alpha-sync/`.

## Review correction R2

The remaining suspended-operation recovery cases are fixed in `4ab6105cf`. A pane-owned observer retains only its own terminal outcome and leftovers while its DOM is suspended, independently of the latest global Settings operation. The observer belongs to retained route memory and is physically unsubscribed when that ownership ends. B can submit and finish before A returns; A still refreshes its committed baseline or recovers its failed write, without consuming B’s result. The existing shared runner, confirmation core and Settings endpoints are byte-identical to R1.

Actual AgentSettingsPanels/AgentForms now preserve the ambiguous-write retry key through automatic staging and repeated suspension. The key survives only while method, URL and body remain identical. An edited request or a definite refusal drops that key. The existing lease/final-operation check still fences a late completion from an earlier owned operation.

A pinned substitution of the R1 product file reproduces all five requested semantic failures (two hook cases and three actual-form cases); nine other tests are unselected. After correction, the related six-suite run passes **87/87**, and the final committed operation suite passes **14/14** after mutation restoration. The related run precedes only TypeScript non-null annotations in mock assertions; its scope is recorded, not relabelled. Controls also cover actual-form success after B replaces the global slot, changed requests, definite refusal and observer cleanup across repeated suspension. Both native typechecks and **382** fragments pass. Eight selected R2 reversals compile, fail their intended assertions, and restore exact committed source. The catalog replaces two obsolete R1 probes with outcome-retention probes and adds five recovery probes; earlier full-catalog results retain their historical scope.

No new PNG or browser execution is claimed for R2. The Details rendering suffix, shared forms, workspace host, stores and runner are unchanged from R1; only Settings recovery logic changed. Prior geometry/SKEW/PNG evidence remains at its original pins with its timestamp and emoji-glyph limitations. The operation tests use inert reader/runner hooks, while the real context and automatic forms execute; they do not claim a Settings Apply or network effect. R2 commands, source bindings and logs are in `checks/review-r2/`.

## Review correction R1 (historical execution scope)

Prism's three findings are fixed. A Settings Apply now records its initiating operation ID and submitted metadata in pane memory. Only that owner consumes leftovers or reloads/resets forms; a suspended owner finishes against refreshed saved data on return, and a late completion cannot reset its next operation. B's staged/typed fields remain intact. StatusEmojiEditor restores both the retained value and its original baseline, including an explicitly cleared value; ordinary editors still seed from saved configuration. Split explicitly focuses its button's pane before opening the picker, including Alt-click.

The CI repair is test-only: exact shell attributes include the new offer/scope, the CSS helper matches an entire selector, and the ESM stub exports the long-standing appStore (also present at d5e2a3c87). Existing assertions and the deliberate missing-export rejection control remain. No product workaround, assertion removal, guard weakening, deadline increase or retry.

Five semantic assertions fail first on R0 (ownership success/failure/suspension, emoji remount, unfocused Alt-split); the focused controls pass after repair. A further suspended-owner control catches seeding from old data before the Details reader reopens. The scoped related run passes 198 tests, final affected suites pass 21, the three CI suites pass 93, and both typechecks pass. After a clean merge of alpha a18ad7428,112 affected tests, both typechecks and **382** fragments pass; own R1 paths are byte-identical (sync-parity.json). Twenty-two compiling reversals finish with 21 assertion-caught and the documented redundant early quote guard. Outputs retain their original execution scopes.

Fresh R1 light/dark browser journeys use clean checkpoint d24a367f10df9cd710579283d44fcb25ef9e2aee (product/test blobs equal 47e05fcdf). Each covers unfocused Alt-split and emoji-plus-description suspension through actual production controls, then the existing full-pane geometry/quote/URL/fallback journey. Settings operation completion controls are inert unit probes, not a browser Apply claim. The early R1 harness diagnostics used the agent's internal rather than display name, then assumed a Basic field was visible while Channels was selected; corrected captures are separate executions. R0 receipts/PNGs are unchanged and never relabelled. Superseded private R1 images left the emoji inputs below the viewport; final captures scroll the actual input into view.

R1 static review covers12 originals with no layout/header/control blocker. The emoji input is visible, but its glyph renders as a box in this environment; browser input-value assertions verify 🎉, while visual glyph coverage remains unconfirmed. The single-pane R1/historical comparison changes only the timestamp adding「昨天」after midnight (588 light/579 dark pixels inside one label); R0’s paired zero-pixel proof retains its original scope.

P3 wording: skew-final-js retains the enumerated JavaScript assets listed in its receipt, not every module; chat-tour.js remains current and the tour is dismissed. The historical control and its hashes remain unchanged.

## Pinned browser evidence (R0 history)

All runs use an owned scratch FleetManager, its actual HTTP server/cookie session/app stream and Chromium. No Fleet start, CLI, vendor account, real AD, pilot or live Fleet. Terminal and step reads are fixture responses. Synthetic IME events exercise the real composer; this is not a native keyboard or mobile OS test.

- `browser/final-light`, `final-dark`: clean source **76cf58bb4cc31c51436038515468ee064d160938**, 15 checkpoints each. Chat/Log/View/Settings, one tools root, quotation and Ctrl+Z, labels/IDs, minimum width/overflow menu, explicit compare reload, ordinary single deep link, narrow/phone fallback. The production Settings suspension leg types different descriptions in A/B, switches compact tabs, expands again and verifies both drafts; no Apply or message send.
- `browser/final-touch`: the same source, 13 checkpoints with a coarse pointer. New header controls stay inside their pane and meet 44 px. Across all three journeys: one document EventSource and one owned server stream; zero page errors/external requests.
- `browser/lifecycles`: the same clean source/harness with the opt-in lifecycle leg. Fifty real close/reopen cycles preserve both drafts and A's File object; B has no attachment. During synthetic composition an unrelated pane/page redraw keeps the composing value outside the draft until compositionend. Two panels, one tools root and one server stream return to their starting counts on every cycle. After explicit GC, JS heap was 6,137,836 → 7,161,628 bytes; this is one bounded comparison, not a long-term leak claim.
- `browser/skew-final-{css,shell,chat,fields,session,context}`: the same source, each retaining that actual asset from alpha **0a05d405f8c85a43d50a0f513253442cbaab874a**. Missing capabilities retain the original chat and unsent text; no half-mounted workspace. CSS runs new JS with old app.css; context covers the retained app-ctx without the form-memory helper.
- `browser/skew-final-js`: a final clean harness-only checkpoint **c63d0fd836121f9c3d6b1b61922a7c99b90935b0** retains the enumerated earlier JavaScript assets with the new CSS (chat-tour.js remains current and the tour is dismissed). Product JS/TS/CSS blobs match **76cf58bb4** exactly; the old tab keeps its single chat and unsent draft.
- `browser/skew-final-server`: the same source with only the server's display marks removed from the real shell response. This models an older server's missing offer; it is not a separate historical server process.
- `browser/before-{light,dark}`: clean capture **76cf58bb4**, substituting recorded browser assets from **0a05d405f** over the same scratch server. This is a controlled renderer baseline, not a historical binary rehearsal. `checks/single-pixel-comparison.json` compares its single-pane PNGs with the final images: **0 differing pixels in both themes**.

Each receipt records its original HEAD/tree/clean flag, input and harness digests, served bytes and exact retained substitutions. Source files are compared with their Git objects before capture and checked unchanged at exit. The source pins above are ancestors of the evidence commit; adding evidence does not relabel executions. Superseded dirty diagnostics and earlier images remain private scratch artifacts and are not presented as final acceptance.

Representative original PNGs:

| State | Light | Dark |
|---|---|---|
| Unchanged single pane | [single](browser/final-light/light-zh-TW-single.png) | [single](browser/final-dark/dark-zh-TW-single.png) |
| Side by side | [right](browser/final-light/light-zh-TW-right.png) | [right](browser/final-dark/dark-zh-TW-right.png) |
| Log beside chat | [log/chat](browser/final-light/light-zh-TW-log-and-chat.png) | [log/chat](browser/final-dark/dark-zh-TW-log-and-chat.png) |
| Stacked | [stack](browser/final-light/light-zh-TW-stack.png) | [stack](browser/final-dark/dark-zh-TW-stack.png) |
| Narrow pane menu | [menu](browser/final-light/light-zh-TW-overflow-menu.png) | [menu](browser/final-dark/dark-zh-TW-overflow-menu.png) |

## Tests and reversals

Commands and output are under `checks/`; redundant trailing blank lines in copied text logs are trimmed (original/normalized digests recorded, originals retained privately). The post-sync core run passed **143 tests**; the related quote/undo/i18n/CSP/Hub-asset/session/model-group run passed **622**. Both typechecks and changelog assembly passed. The latest alpha merge was clean; an earlier plain merge resolved seven disclosed overlaps and retained the incoming effort-field behavior.

`scripts/manual/mutation/desktop-chat-workspace-3637.py` runs offline against exact committed source and restores every file in `finally`. **17 reversals: 16 assertion-caught and one redundant early quote check**; removing both quote-currency checks is caught. JavaScript variants pass `node --check`; the TS mark reversal is transpiled/executed by Vitest. The checks cover distinct agents, actual width, viewer scope, pane-local guards, delayed loading, retired entry, quote currency/undo, synchronous/asynchronous form IDs, Settings remounts, suspended form/guard ownership and retirement, logout and gateway display exclusion. `checks/current-mutations/receipt.json` pins **2528bac5**; all tested product blobs are identical at the browser source **76cf58bb4** (the later commit corrects only the harness's original-value restoration).

Earlier diagnostic output remains honestly scoped: a combined run made concurrently with typechecks/browser rigs timed out in two beforeAll hooks and the UI-literal scanner (709 passed, 20 skipped by failed hooks, one timeout). Its three suites passed 25/25 alone with unchanged assertions/10 s limits. The later clean alpha merge includes #3669's import-budget fix. This PR changes no deadlines or retries. An initial suspension browser leg reached both restored forms but its cleanup incorrectly assumed fixture descriptions were empty; the harness now restores the captured original values and awaits unstaging. That failed cleanup is a private diagnostic, not acceptance.

Fail-first probes also caught the actual page Undo path losing B's draft, asynchronous emoji IDs colliding, a retained Settings form losing staged changes at the first host remount, the newly merged effort field's duplicate ID, and Settings draft loss on compact suspension. Fleet, Classic and native hooks now retain their edited values across unmount; a hidden pane still guards leaving, and accepting one discard remains effective when the other pane cancels. The browser/pixel comparison caught and fixed a default sidebar width regression. No authority, Settings digest, ticket, write endpoint or backend behavior was changed.

Reproduce from this checkout (set the locally installed `PW_DIR` and `CHROME` paths):

```sh
REPO="$PWD" OUT="$PWD/.artifacts/split-chat-pr2" npx tsx scripts/manual/smoke/smoke-split-chat-workspace-3637.mts
LIFECYCLES=1 REPO="$PWD" HP=55904 OUT="$PWD/.artifacts/split-chat-pr2-life" npx tsx scripts/manual/smoke/smoke-split-chat-workspace-3637.mts
SETTINGS_SUSPEND=1 REPO="$PWD" HP=55920 OUT="$PWD/.artifacts/split-chat-pr2-settings" npx tsx scripts/manual/smoke/smoke-split-chat-workspace-3637.mts
python3 scripts/manual/mutation/desktop-chat-workspace-3637.py
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.test.json
```

Per the owner's updated process, each PR retains its PNGs and goes directly to parity review; the consolidated all-layout/gesture owner set follows PR4.

No schema migration. Rollback: revert this feature change while retaining PR1 and unrelated alpha changes. Older tabs/compare links fall back to the normal first-agent route; the saved topology contains no credentials, messages, files or drafts. Chromium geometry and synthetic composition do not replace Firefox/Safari/native IME acceptance. Live sandbox movement, drag/sash geometry and pop-out handoff remain the later slices' evidence.
