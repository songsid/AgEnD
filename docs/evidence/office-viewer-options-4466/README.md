# Office: viewer options (#4466)

Captures of the real Office UI, taken in headless Chromium with the smoke fixture. The pack is synthetic (four rooms, one drawn figure) and the agents are the fixture's Alpha … Echo, with made-up levels: no real names.

- **Build:** this branch with the rename-field fix (`fix(office): keep what is typed in the rename field`), the commit before this folder's.
- **Script:** `capture.mts`. Copy it to `scripts/manual/smoke/` and run it with `REPO=<checkout> OUT=<dir> DEV=desk` (or `DEV=phone PW_DPR=3`), using the same Playwright image the ui-gate smokes use. It runs all four of light/dark × EN/zh-TW and writes `report-<dev>.json`. This folder keeps a selection; every case was run.
- Desktop is 1366×900; phone is 390×844 at 3×.

## What each capture shows

| Feature | Captures |
|---|---|
| ⚙ Display options has the two new switches | `desk-light-en-1-options-menu`, `desk-dark-zh-TW-1-options-menu`, `phone-light-zh-TW-1-options-menu` (the phone's ⋯ sheet), `phone-dark-en-2-options-ticked` |
| **Hide names and levels**: the tags and their level badges go; the people stay | before `desk-light-en-0-start`; after `desk-light-en-3-names-and-minimap-hidden`, `desk-dark-zh-TW-3-…`, `phone-light-zh-TW-3-…` |
| **Hide the minimap**: zoomed in, the minimap (bottom right) goes | before `desk-light-en-0-start`; after `desk-light-en-3-names-and-minimap-hidden`, `desk-dark-zh-TW-3-…` |
| **✎ on the card**, the field, and the new name on the card, the tag, the desk list and the tooltip (Alpha → 陽奈) | `desk-light-en-4-card-pencil`, `-5-rename-field`, `-6-renamed`; `desk-dark-zh-TW-6-renamed`; `phone-light-zh-TW-5-rename-field`; `phone-dark-en-6-renamed` |
| **A carded person stays put**: with Alpha's card open, Alpha crashes and is due at the Help desk | `desk-light-en-7-carded-0s` and `-8-carded-10s`: still in the Lounge 10 s later, standing as before (the card only sets where they walk to; nobody is picked up, so no carried pose). `-9-closed-walked`: 10 s after the card closes, at the Help desk. Also `desk-dark-zh-TW-8-carded-10s`, `phone-light-zh-TW-8-carded-10s`, `phone-dark-en-9-closed-walked` |

From the reports, in all 8 cases: the minimap was shown zoomed in, gone with the switch on and back with it off (desktop); the card and the desk list both read 陽奈 after Enter; the card's state line read Crashed / 已當掉 while Alpha stood still; no page errors and no CSP violations.

**A phone has no minimap.** `app.css` already hides `.oo-mini` on a narrow screen, so on a phone the switch is saved but changes nothing you can see. It is listed there like the other options, which are also per browser.

## Fixed while capturing

On the phone run the new name did not stick: the field was drawn with `value=`, and Preact writes a `value` prop back on every render, so each status update the card got (often, on a live office) put the name back over what was being typed. The field is now filled once, in a layout effect, as it appears. `tests/web-office-names.test.ts` has a case for it: type, redraw the card, the typing is still there and Enter saves it.

## Each test fails when its feature is broken

Run with `tests/web-office-names.test.ts tests/office-toolbar-m3556.test.ts` (12 tests). Each change is made alone, then put back:

| Broken on purpose | Result |
|---|---|
| `renamedView` returns the view as given | 1 failed: `renamedView: a renamed person's nickname …` |
| No ✎ on the card (`CardName` always returns the plain name) | 2 failed: `Enter saves what was typed …`, `what is typed stays when the card draws again …` |
| **Hide the minimap** does nothing (the `<svg>` drawn whatever `miniOff` is) | 1 failed: `desk > Display options: a dropdown with style, the toggles …` |
| The field drawn with `value=` again | 1 failed: `what is typed stays when the card draws again …` |
| All put back | 12 passed |

Staying put while carded and hiding the tags are drawn on the canvas and have no unit test; the captures above are their check. `tsc --noEmit`, `npm run build` and every `tests/*office*` file (81 files, 1161 tests) pass.
