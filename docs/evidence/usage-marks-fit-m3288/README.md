# Usage: a stale login with no agents fits its one-line row (M-3288, #4112)

Source `bac15ff43dbc603fe9a38632eca8fcf83d23d553`, from dev tip `b644a3078`.

**Cause.** In one line per login (the grouped view's −/+, #4054), the row's head is a third of the line (`.u-crow.is-one > .u-crow-head { flex: 0 0 32% }`). A login both stale and used by no agent puts three things there: the name, the ⓘ (#4069) and the cached words ("cached at 10:47", `flex: none; white-space: nowrap`). The words can't shrink, so they ran 10–32 px into the window's tag and bar, and the name was squeezed to 0 px.

**Fix.** In one line per login, the cached mark is a 13 px clock icon. Its words are its `title` and are read aloud: the visually hidden text holds the full "expired · cached at 10:47 — …". The name and the ⓘ keep their room. Rows that show every window keep the words as before. The change is in the stylesheet: the same markup carries both, and `.u-crow.is-one` picks which one shows.

**Fail-first.**

- Layout, in a real browser: `scripts/manual/smoke/smoke-usage-marks-fit-m3288.mts` measures every row of the Codex and Claude groups. Each part (the name, the ⓘ, the cached mark, the window's tag, bar, percent and reset) must stay inside the row and overlap no other part. The percent and the cached mark must not be cut, the name must keep at least 14 px, and both marks must be present. It covers every window and one line per login, on the desk's side rail and Usage window and the phone's Usage window, in en and zh-TW.
  - On the dev tip it fails in all four cases: the cached mark overlaps the window tag by 32 / 10 / 21 px and the name is squeezed to 0 px; on phone zh-TW the name alone is squeezed to 0 px. The desk Usage window was wide enough and passes.
  - With the fix all four pass. It is added to the CI UI gate at HP 19705.
- Unit: `tests/usage-marks-fit-m3288.test.ts` checks, in one line, the clock (aria-hidden), the tooltip and the spoken words with the time in en and zh-TW, the words kept in every-window rows, and the stylesheet's three rules. On the dev tip 4 of 4 fail; with the fix 4 of 4 pass.
- `tests/usage-compact.test.ts` read the cached words as the mark's first child, which is now the icon. It now reads `.u-crow-stale-text`, with the same expectation.

**Related.** 94 files that touch the usage dialog or app.css pass (1,356 tests), as do 36 docs, skill, changelog and CI files (960 tests). `typecheck:tests` is clean.

**Images** (headless Chromium on the smoke fixture; fake logins and agents):

- `before-*-rail-2-one-line.png` / `after-*-rail-2-one-line.png`: the desk side rail, one line per login (en light, zh-TW dark).
- `*-rail-1-every.png`: every window, unchanged.
- `*-phone-*-window-2-one-line.png`: the phone's Usage window, one line per login.

**Rollback.** A plain revert. No stored state is touched.
