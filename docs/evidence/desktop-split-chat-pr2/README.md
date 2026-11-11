# Desktop split chat — PR2 (#3637)

桌面可同時開兩個不同 Agent，左右或上下排列；每格沿用原有文字分頁。一般側欄點擊換目前窗格，文字可引用到另一格草稿，不會送出。窄畫面一次只顯示一格，以 Agent 分頁切換。拖曳、分隔線、頁內浮窗及真正 pop-out 依已同意設計留在 PR3／PR4，本 PR 不顯示未完成入口。

The existing app router, stream, chat store, preview slot and Settings runner retain ownership. The new host mounts two complete existing panels. It does not start an agent or grant authority. Single-pane IDs and resting geometry retain their defaults. Entering/leaving a workspace cannot silently discard an unsaved Settings form: the existing discard guard runs before the remount. Compact suspension unmounts hidden readers while retaining each Settings form and its leave guard in pane-owned memory; it never stores typed values in localStorage.

## Pinned browser evidence

All runs use an owned scratch FleetManager, its actual HTTP server/cookie session/app stream and Chromium. No Fleet start, CLI, vendor account, real AD, pilot or live Fleet. Terminal and step reads are fixture responses. Synthetic IME events exercise the real composer; this is not a native keyboard or mobile OS test.

- `browser/final-light`, `final-dark`: clean source **76cf58bb4cc31c51436038515468ee064d160938**, 15 checkpoints each. Chat/Log/View/Settings, one tools root, quotation and Ctrl+Z, labels/IDs, minimum width/overflow menu, explicit compare reload, ordinary single deep link, narrow/phone fallback. The production Settings suspension leg types different descriptions in A/B, switches compact tabs, expands again and verifies both drafts; no Apply or message send.
- `browser/final-touch`: the same source, 13 checkpoints with a coarse pointer. New header controls stay inside their pane and meet 44 px. Across all three journeys: one document EventSource and one owned server stream; zero page errors/external requests.
- `browser/lifecycles`: the same clean source/harness with the opt-in lifecycle leg. Fifty real close/reopen cycles preserve both drafts and A's File object; B has no attachment. During synthetic composition an unrelated pane/page redraw keeps the composing value outside the draft until compositionend. Two panels, one tools root and one server stream return to their starting counts on every cycle. After explicit GC, JS heap was 6,137,836 → 7,161,628 bytes; this is one bounded comparison, not a long-term leak claim.
- `browser/skew-final-{css,shell,chat,fields,session,context}`: the same source, each retaining that actual asset from alpha **0a05d405f8c85a43d50a0f513253442cbaab874a**. Missing capabilities retain the original chat and unsent text; no half-mounted workspace. CSS runs new JS with old app.css; context covers the retained app-ctx without the form-memory helper.
- `browser/skew-final-js`: a final clean harness-only checkpoint **c63d0fd836121f9c3d6b1b61922a7c99b90935b0** retains all earlier JavaScript with the new CSS. Product JS/TS/CSS blobs match **76cf58bb4** exactly; the old tab keeps its single chat and unsent draft.
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
