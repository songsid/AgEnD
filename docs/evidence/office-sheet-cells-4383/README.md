# Office packs: sheet cells, pat, stand and card motion (#4383)

Captures of the real Office UI in headless Chromium, run with the smoke fixture against a synthetic pack. The pack has no real names: three fixture agents, Alpha (working), Beta and Gamma (idle). `capture.mts` is the capture script. Copy it to `scripts/manual/smoke/` and run it with `REPO=<checkout> OUT=<dir> LABEL=after`, using the same Playwright image the ui-gate smokes use.

- **After:** branch head `c8c64aca`, which has the 64 Mpx cap restored. This folder's commit adds only these files.
- **Before:** `074e5886`, the tip of the base that was merged into the branch.

## The pack

All the characters come from one shared 512 × 320 sheet (`sheet.png`). It has 8 columns and 4 rows of 64 × 80 cells:

- **Rows:** row 0 is idle (2 frames), row 1 is working (4), row 2 is `pat` (4 frames, `once: true`), and row 3 is `stand` (1).
- **Columns:** the default set uses `col: 0`. Beta's set uses `col: 4`, with a green coat.
- **Labels:** each cell has a label in its top-left corner, so a capture shows which cell was drawn: `I0`/`I1`, `W0`–`W3`, `P0`–`P3` and `ST`.
- **Card:** the pack sets `card.layout.gap: 48` and `card.motion: { enter: "pop", ms: 420 }`, on the `rpg` preset with the `lg` avatar.

## What the captures show

| File | What it shows |
|---|---|
| `after-desk-dark-en-1-office.png` | The upload is accepted (`ok`). Alpha works at a desk, drawing `W*` cells from row 1. Beta and Gamma idle in the lounge with `I*` cells from row 0, each set cutting its own columns of the one sheet. |
| `after-desk-dark-en-3-card.png` | Beta's card has a clear gap from Beta. Its avatar is the `stand` cell (`ST`), not a walking or idle frame. |
| `after-desk-dark-en-4-pat-0…3.png` | Pat pressed. At 150 ms Beta shows `P0`. About 0.5 to 0.9 s later Beta shows `P2` and then `P3`, with the hearts. About 2.3 s after the press Beta is back to the idle `I1`: the `once` strip played a single pass. |
| `after-phone-dark-zh-TW-1-office.png`, `-3-card.png` | Phone, 390 × 844. The same pack, with the card as a bottom sheet. The pack's `rpg` / `lg` card makes that sheet taller (550 px against 414 px for the built-in card), so it covers the people and the pat is shown on the desktop captures. |
| `before-builtin-*.png` | The base refuses this pack: `skin_manifest_invalid`, `characters.default: unknown key "pat"`. So the before captures are the built-in default style: the card, and a pat with only the hearts and words. |
| `after-builtin-desk-dark-en-3-card.png` | The head with the built-in default style. The card's top 260 px (header and avatar) is **pixel-identical** to the base capture: built-in styles still draw the card avatar idle. Prism's P2 on `stand` is fixed. |

Neither run had page errors or CSP violations.

## Limits

The pack keeps the 64 Mpx decoded-pixel cap. With real art, the 42 MiB byte cap binds first, near 87 Mpx. The author measured 96 Mpx with a 46.3 MiB pack, which a normal upload refuses, and no real-device phone image budget has been measured yet. So this PR raises only the file and byte limits.
