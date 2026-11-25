# Office: viewer options (#4466)

Captures of the real Office UI, taken in headless Chromium with the smoke fixture. The pack is synthetic (four rooms, one drawn figure) and the agents are the fixture's Alpha … Echo, with made-up levels: no real names.

- **Build:** this branch with the review's caller fixes: the commit that adds `tests/office-callers-4467.test.ts`.
- **Script:** `capture.mts`. Copy it to `scripts/manual/smoke/` and run it with `REPO=<checkout> OUT=<dir> DEV=desk` (or `DEV=phone PW_DPR=3`), using the same Playwright image the ui-gate smokes use. It runs all four of light/dark × EN/zh-TW and writes `report-<dev>.json`. This folder keeps a selection; every case was run.
- Desktop is 1366×900; phone is 390×844 at 3×.

## What each capture shows

| Feature | Captures |
|---|---|
| ⚙ Display options has the two new switches | `desk-light-en-1-options-menu`, `desk-dark-zh-TW-1-options-menu`, `phone-light-zh-TW-1-options-menu` (the phone's ⋯ sheet), `phone-dark-en-2-options-ticked` |
| **Hide names and levels**: the tags and their level badges go; the people stay | before `desk-light-en-0-start`; after `desk-light-en-3-names-and-minimap-hidden`, `desk-dark-zh-TW-3-…`, `phone-light-zh-TW-3-…` |
| **Hide the minimap**: zoomed in, the minimap (bottom right) goes | before `desk-light-en-0-start`; after `desk-light-en-3-names-and-minimap-hidden`, `desk-dark-zh-TW-3-…` |
| **✎ on the card**, the field, and the new name on the card, the tag, the desk list and the tooltip (Alpha → 陽奈). On a phone the pencil stays 24 px with no square behind it, the name's row 24 px tall; a clear `::after` reaches the 44 px target (`report-phone.json`, `pencil.reachPx`: 21–22 px from its centre each way, as the close button) | `desk-light-en-4-card-pencil`, `-5-rename-field`, `-6-renamed`; `desk-dark-zh-TW-6-renamed`; `phone-light-zh-TW-5-rename-field`; `phone-dark-en-6-renamed` |
| **A carded person stays put**: with Alpha's card open, Alpha is paused and due at the Nap corner | `desk-light-en-7-carded-0s` and `-8-carded-10s`: still in the Lounge 10 s later, standing as before (the card only sets where they walk to; nobody is picked up, so no carried pose). `-9-closed-walked`: 10 s after the card closes, in the Nap corner. Also `desk-dark-zh-TW-8-carded-10s`, `phone-light-zh-TW-8-carded-10s`, `phone-dark-en-9-closed-walked` |
| **…but a caller is not** (review 1): the card open again, Alpha crashes | `desk-light-en-10-carded-caller-walked`, `desk-dark-zh-TW-10-…`, `phone-light-zh-TW-10-…`: 12 s later, at the Help desk with the card still open |
| **Names hidden, the caller keeps their tag** (review 2) | `desk-light-en-11-names-hidden-caller-tagged`, `desk-dark-zh-TW-11-…`, `phone-dark-en-11-…`: the four in the Nap corner have no tag; 陽奈, calling at the Help desk, keeps their name but not the level badge (the option hides levels) |

From the reports, in all 8 cases: the minimap was shown zoomed in, gone with the switch on and back with it off (desktop); the card and the desk list both read 陽奈 after Enter; the card's state line read Paused / 已暫停 while Alpha stood still, then Crashed / 已當掉 as Alpha walked to the Help desk; no page errors and no CSP violations.

**A phone has no minimap.** `app.css` already hides `.oo-mini` on a narrow screen, so on a phone the switch is saved but changes nothing you can see. It is listed there like the other options, which are also per browser.

## Fixed while capturing

On the phone run the new name did not stick: the field was drawn with `value=`, and Preact writes a `value` prop back on every render, so each status update the card got (often, on a live office) put the name back over what was being typed. The field is now filled once, in a layout effect, as it appears. `tests/web-office-names.test.ts` has a case for it: type, redraw the card, the typing is still there and Enter saves it.

## Each test fails when its feature is broken

Run with `tests/web-office-names.test.ts tests/office-toolbar-m3556.test.ts tests/office-callers-4467.test.ts` (28 tests). Each change is made alone, then put back:

| Broken on purpose | Result |
|---|---|
| `renamedView` returns the view as given | 1 failed: `renamedView: a renamed person's nickname …` |
| No ✎ on the card (`CardName` always returns the plain name) | 2 failed: `Enter saves what was typed …`, `what is typed stays when the card draws again …` |
| **Hide the minimap** does nothing (the `<svg>` drawn whatever `miniOff` is) | 1 failed: `desk > Display options: a dropdown with style, the toggles …` |
| The field drawn with `value=` again | 1 failed: `what is typed stays when the card draws again …` |
| A carded caller stays put (`cardStay` without its `CALLING` check) | 3 failed: `card open, then needs / crashed / stuck: the target is their Help-desk seat …` |
| A caller loses their tag with names hidden (`tagged` without its `CALLING` clause) | 6 failed: `hidden, Alpha needs / crashed / stuck …` |
| A caller's tag brings back the level badge (`q.look` drawn in place of `tagLook(q)`) | 3 failed: `hidden, Alpha needs / crashed / stuck: Alpha's name, still without the level` |
| All put back | 28 passed |

`tests/office-callers-4467.test.ts` checks staying put through `cardStay` (the walk tick's step) and the tags through `drawPart`, as the page draws them. The tags of a tile too small to read stay off, a caller's too. `tsc --noEmit`, `npm run build`, every `tests/*office*`, docs and changes test file (89 files, 1315 tests) and the eight Office ui-gate smokes pass.
