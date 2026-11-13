# Chat menus and favourites — M-2959

A split-pane menu repeated Split and mixed model commands with layout and appearance actions. Sidebar stars and menus competed for space, selected-text quote actions had different presentation, and some light-theme identity colours were too pale.

The existing Menu now groups pane, agent, appearance and delete actions. Model and effort opens the existing guarded runtime Settings form. Sidebar favourites and More share one slot. Quote actions use the other pane's display name and the same icon/label row; quoting edits a draft without sending it. Light sidebar name shading includes selected, hovered and recent-reply backgrounds; dark shading is unchanged. No endpoint or authority rule changes.

## Browser evidence

The serial Chromium rehearsal uses a disposable scratch FleetManager, actual cookie sign-in, HTTP/SSE and production UI. Status/model/colour/display-name inputs and chat text are fixtures. The Fleet is never started. There are no real accounts, backend CLIs, vendor calls, AD or pilot operations. The only preference writes add/remove the signed-in fixture operator's own favourites. Agent Settings also makes its existing read-only status-emoji preview POST, inventoried separately from writes.

Every completed receipt records its clean capture-time HEAD/tree, source/harness digests, actual served JS/CSS digests, exact retained substitutions, browser version, geometry, one-stream counts, action checks and request inventory. `manifest.json` is digest-first. Incomplete/load-paused diagnostics are private, absent from this gallery. Earlier captures are never relabelled as later executions.

| Runs | Viewports and scope |
| --- | --- |
| `after-{desktop,phone}-{light,dark}-{en,zh-TW}` | Current UI: desktop 1600×1000 and phone 390×844; one-slot favourites, keyboard menu, icons/groups, quote insertion and model Settings navigation on desktop; phone tap sizes and settled sidebar |
| `before-{desktop,phone}-{light,dark}-{en,zh-TW}` | Same fixture server, exact seven pre-change UI assets from `3f02d04404f40596e9ee25b908f3bb9c793d70dd`; sidebar, old desktop menu and quote presentation |
| `skew-{css,ui-menu,instance-nav,host,quote}` | Each named retained asset against current assets, zh-TW light desktop; linking and bounded functional controls |
| `narrow360` | Current zh-TW light at 1200 px viewport, real sash dragged to the 360 px minimum; menu bounds and quote/settings journey |

The before control substitutes exactly `chat-workspace.js`, `chat-quote.js`, `panel-chat.js`, `instance-nav.js`, `ui-menu.js`, `identity-color.js` and `app.css`; it is a UI baseline on the current fixture server, not an old-server run. SKEW retains the named file only. It does not claim a whole previous release or native/other-browser matrix. Phone falls back to the existing single chat, so the split-pane menu and cross-pane quote journey are desktop controls. The existing Details page header can still show an internal instance name; this PR changes the menu and quote display labels, not that page.

Current zh-TW originals:

- Desktop light: [pane model menu](browser/after-desktop-light-zh-TW/light-zh-TW-pane-model.png), [quote options](browser/after-desktop-light-zh-TW/light-zh-TW-quote-options.png)
- Desktop dark: [pane model menu](browser/after-desktop-dark-zh-TW/dark-zh-TW-pane-model.png), [quote options](browser/after-desktop-dark-zh-TW/dark-zh-TW-quote-options.png)
- Phone: [light sidebar](browser/after-phone-light-zh-TW/light-zh-TW-sidebar-rest.png), [dark menu](browser/after-phone-dark-zh-TW/dark-zh-TW-sidebar-menu.png)

Known SKEW presentation limit: pre-change `app.css` lacks the new label/value styling, so that control's model value wraps and loses grey styling. Navigation remains functional; this run does not claim visual equivalence with current CSS.

## Offline checks

The clean input commit `537ffc7c0` passed **253 tests across 17 focused files** with one worker. All **11 compiling semantic reversals** failed their intended assertions and were restored byte-for-byte. Logs and capture-time input digests are in [offline/](offline/). Full stdout is archived losslessly as gzip (fixed archive timestamp); `log-archives.json` records its uncompressed digests.

Both native TypeScript checks and the build passed in [CI 43187101842 at `50826808`](https://github.com/songsid/AgEnD/actions/runs/43187101842). Its entire `src` and `tests` trees, package/config files and workflow are byte-identical to the checked local commit; [type-parity.json](offline/type-parity.json) records the Git objects and successful setup job. Final local native type checks were paused before starting when load exceeded 10. No current local type execution is claimed. The packaged PR head must pass its own required CI.

The capture verifier passed **22 runs, 550 input bindings, 3,477 served-asset bindings, 61 retained substitutions, 172 checkpoints and 94 PNGs**. Captures bind clean commits `9d5430975` and `537ffc7c0`; their product and harness inputs match the final files exactly. [visual-read.md](visual-read.md) names the 27 selected originals read visually and the retained-CSS presentation limit.

Fail-first restores those seven exact pre-change UI files: five intended assertion failures with two stateful setup controls passing. This was a pre-commit test execution: its three test digests match the committed `bbe54920f` blobs, and its seven source digests match the baseline Git objects. The receipt pins those original bytes; it is not relabelled as a final-head execution. Mutations compile with `node --check` and must fail an assertion, then restore the original bytes in `finally`; transform failures do not count. All local Vitest runs use one worker and start only below the host load limit.

```sh
npx vitest run tests/web-chat-menus-2959.test.ts tests/web-chat-quote-2789.test.ts tests/web-chat-workspace-entry-3637.test.ts --maxWorkers=1
python3 scripts/manual/mutation/chat-menus-2959.py .artifacts/chat-menu-mutations
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.test.json
python3 scripts/manual/verify-chat-menus-2959.py
```

## Risks and rollback

Native popovers are used only when both the browser and current CSS support them; retained CSS uses the ordinary Menu path and one ordinary More trigger. Existing favourite limits, per-account storage, read-only/guest restrictions and navigation guards remain. Reverting this PR restores the prior presentation; favourite preferences stay compatible. No data migration is involved.

## R1 review pin

[R1](r1/README.md) adds checked/unchecked icon-radio and icon-checkbox assertions for Fable’s M2. Three compiling reversals are caught, restored suites pass39/39, and the current test typecheck passes. Product source, harnesses and all browser originals are unchanged from R0.
