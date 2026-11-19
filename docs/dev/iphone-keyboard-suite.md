# iPhone keyboard regression suite (M-3357)

Several betas in a row fixed one iPhone keyboard bug and brought another back. The suite collects every past case in one place. Each case is pinned by unit tests on the real Shell and composer, and shown in the real app by WebKit smokes. Each case also carries a **revert**: its fix undone in today's code, which must turn its own tests red. If a revert stays green, the suite no longer protects that case.

The manifest is `scripts/ci/keyboard-suite.mjs` (`CASES`), and it is the source of truth. This page is the human view.

The reverts are synthetic: each one undoes the fix in the code as it is today. They are not the code from before the fix. Some lines never existed on the dev branch; for example, `tallest = window.innerHeight || 0` stands in for #2478's old innerHeight test. What a revert must do is take away the mechanism its case depends on, so that the case's tests show they would notice it going.

## When it runs

- **Every PR.** `tests/keyboard-suite-m3357.test.ts` runs in the unit shards. It checks that each listed test title is still in its file and each smoke exists. It also checks that each revert's text appears exactly once in its file. If a refactor moves a fix, update that case's revert so it undoes the fix in the code as it now stands.
- **A change to the keyboard's code** (`KEYBOARD_PATHS`), or to the suite itself, runs CI's `keyboard-suite` job, which `build` requires. The keyboard's code is the shell's keyboard fit (`app-shell.js`), `app.css`, `app.html`'s viewport, the Fleet and Hub composers, and the document listeners that read the box (`text-undo.js`, `chat-quote.js`). The job runs:
  1. `--unit`: every case's tests pass (each one found and run, never skipped);
  2. `--reverts`: each fix undone, one at a time, turns at least one of its own tests red (about 4 minutes);
  3. `--smokes`: the five keyboard smokes in WebKit (Safari's engine), from the digest-pinned Playwright image.
- A push, a tag or a manual run has no diff to judge, so the job runs everything (fail closed).
- The smokes run in the image's node (24) on the node_modules the runner installed with node 22. This works because no native module is on the smokes' path. If one ever is, for example the fixture opening SQLite, run `npm rebuild` in the image or match the runner's node to the image's.

Locally:

```sh
node scripts/ci/keyboard-suite.mjs --list            # the cases, their tests, smokes and reverts
node scripts/ci/keyboard-suite.mjs --unit
node scripts/ci/keyboard-suite.mjs --reverts [id…]   # rewrites one source file at a time and always puts it back, also on Ctrl+C / SIGTERM (not on SIGKILL): run it in a worktree
# The WebKit smokes, as CI runs them (node_modules from `npm ci` on the host):
docker run --rm --init --ipc=host --memory 3g --user "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD:$PWD" -w "$PWD" \
  -e PW_ENGINE=webkit -e PW_DIR="$PWD" -e REPO="$PWD" -e OUT=/tmp/kb \
  mcr.microsoft.com/playwright:v1.64.0-noble node scripts/ci/keyboard-suite.mjs --smokes
```

## The cases

| Case | Card / PR | What the person saw |
|---|---|---|
| `tabs-over-keyboard` | #2478 | With the keyboard up, the bottom tabs and the line under the composer sat between the box and the keyboard. |
| `candidate-bar-flips-tabs` | #2517 | An IME's candidate bar crossing the keyboard threshold took the tabs out and back on every key, and after a pause. |
| `composition-without-end` | #2517 | A composition with no `compositionend` (the field left or removed) froze the keyboard state. |
| `composer-ime-ownership` | #2517 | Mid-composition the page wrote the box (its value, its height), so iOS redrew the candidate bar on every key. |
| `band-under-composer` | M-3111 #3900 | A black band between the composer and the keyboard; the box snapped on the way down. |
| `realign-per-key` | #4011 (beta.4) | One reading per key said "no keyboard", so the page re-aligned on every key. |
| `shell-steady-per-key` | M-3206 #4026 | The shell followed every per-key reading (suggestion bar, a few px of pan): the box moved on every key. |
| `composer-height-per-key` | M-3206 #4026 | The box collapsed and re-measured its height on every key. |
| `box-under-candidate-bar` | M-3244 #4057 | Mid-composition the view got shorter and the shell didn't follow: the box sat under the keyboard. |
| `zhuyin-per-character` | M-3265 #4089 | 注音: every character moved the box twice (up for its bar, down after it was chosen). |
| `zhuyin-per-key-nudge` | M-3265 #4089 | 注音: each key while the candidates showed nudged the view a few px, and the shell followed each nudge. |
| `open-header-drop` | M-3327 #4171 | Opening: the header dropped to mid-screen over a black band, then snapped back. |
| `close-midair` | M-3327 #4171 | Closing: the box hung mid-air over a band for ~350 ms, then dropped in one frame. |
| `tap-focused-box` | M-3327 #4171 | A tap on a box that already had the focus: iOS's keyboard-sized pan was held instead of undone. |
| `focus-to-another-field` | M-3327 #4171 | Moving from the box to another text field counted as the keyboard going away. |
| `selection-reads-composing` | M-3356 #4208 | 注音 flickered iOS's candidate bar: the undo history read the box's selection on every composition key. |
| `quote-reads-composing` | M-3356 #4208 | The same, from the Quote pill's selection check. |

The smokes are `smoke-ime-composition`, `smoke-phone-kb-steady`, `smoke-phone-ime-keyboard-m3244`, `smoke-phone-typing-steady-m3265` and `smoke-phone-keyboard-motion-m3327`. `--list` shows which cases each one covers.

#2478's own smoke (`smoke-2478-keyboard`) has been retired (M-3362). It measured the bottom tabs in an agent's chat, and M-3115 (#3911) removed the tabs from an agent's pages, so it failed on today's app for a reason that had nothing to do with the keyboard. The `tabs-over-keyboard` case is pinned by its unit tests in `tests/web-keyboard-2478.test.ts`, including the CSS rule that hides the tabs with the keyboard up. The box staying on the keyboard is shown in WebKit by `smoke-phone-kb-steady` and `smoke-phone-keyboard-motion-m3327`.

## What only a real iPhone or the iOS Simulator can see

No headless browser raises an on-screen keyboard or draws iOS's own interface. The smokes install a stand-in `visualViewport` that replays what recordings showed iOS doing, and they fire WebKit's composition events around real keys. The suite therefore pins the **page's** behaviour: what it writes, reads and moves, per key and per frame. It cannot see the following:

1. **iOS's candidate bar and predictive row, and their redraws.** M-3356's flicker was the bar blanking, not the page moving. The suite pins the cause (no selection read, no style write while composing), not the blanking itself.
2. **The keyboard's real animation and the order and timing of iOS's events.** That covers `resize`, `scroll`, the pan, `focusout`, and `compositionend` before or after the last `input`. The stand-in replays one recording's model (M-3327: both orders each way), and a new iOS version may change it.
3. **iOS's own pan** to show the focused box, how far it pans, and whether `scrollTo(0, 0)` ends it. The stand-in assumes Safari's behaviour as recorded.
4. **A tap on a box that already has the focus.** No focus event arrives; only the pan iOS chooses does.
5. **Real heights for each keyboard and input mode**: 注音, pinyin, kana, emoji, dictation, and a hardware keyboard's bar. The tests use representative numbers (a 44 px bar, a 120 px compact keyboard).
6. **Safe-area and home-indicator insets in WebKit.** There is no CDP inset override there; Chromium covers the inset in `smoke-phone-kb-steady`'s rest case.
7. **The installed home-screen app versus a Safari tab**, Safari's collapsing toolbars, rotating with the keyboard up, and iPad split or floating keyboards.
8. **Frame-level rendering**: a one-frame flash from compositing, rubber-band overscroll, ProMotion timing.

### The Simulator leg (planned)

Once Xcode is installed on the Mac, dev-claude2 will add a Simulator recording leg. In the iOS Simulator's Safari, and in the installed web app, it will record:
- the keyboard opening and closing;
- a tap on an already-focused box;
- steady English typing;
- 注音 typing with the candidate bar.

That covers items 1–5 and 7, frame by frame against the cases above. Item 8 and device-specific timing still need the user's iPhone after each beta.

## Adding a case

When a new keyboard bug is fixed:
1. Add a unit test on the real Shell or composer that fails on the base.
2. If the real app shows it, extend or add a WebKit smoke.
3. Add the case to `CASES` with its card or PR, the tests' titles, the smokes, and a revert that undoes the fix in today's code.
4. Run `--reverts <id>` and see it go red.
5. If the fix lives in a file not yet in `KEYBOARD_PATHS`, add the file there.
6. Add a row to the table above.
