# The Office toolbar in one row, with ⚙ Display options (M-3556)

The user saw the before/after of a prototype and approved it on 2026-11-24. They also chose that the Hub room office's gear opens the same dropdown, and that 成員 stays in the row.

All captures are of the real app, taken headless with Chromium and made-up data:

- **Fleet office:** the smoke fixture, with eight agents and two stored offices. No live provider, CLI or Fleet is involved.
- **Hub room office:** a real Hub from this branch on a scratch SQLite, with a 30-agent room of made-up owners.

## What changed

- **Desk: one row.** At 1366 px the bar is 30 px tall instead of 68 px (two rows).
  - Left: what you're looking at (辦公室 ▾, 顯示 ▾, 成員).
  - Right: the actions (編輯辦公室, 分享…) and **⚙ 顯示選項**.
- **⚙ 顯示選項 is a dropdown, like 成員, not a window over the office.**
  - It holds 風格, 隱藏暫停與停止的成員, 拖曳與摸頭, 0–6 點就寢, (所有辦公室: 大廳格) 對話框 and 圖例.
  - A tick takes effect at once and the dropdown stays open. A click elsewhere or Esc closes it.
  - 圖例 is now a tick, like the rest. Every option label has one style; 隱藏暫停… was smaller and grey on a desk.
  - With reduced motion, the M-3547 note sits on its own line under 拖曳與摸頭.
- **Phone.** The ⋯ sheet lists the same groups in the same order:
  - scope;
  - a 顯示選項 heading, then the options;
  - a thin rule, then the actions.

  The 辦公室 and 顯示 pickers are spaced like the rest; before, they nearly touched.
- **Hub room office.**
  - Desk: the gear under the zoom buttons opens the same dropdown, beside the zoom buttons from their top. The room page keeps the open state, so a click elsewhere or Esc closes it there. In a room it holds 隱藏暫停與停止的成員, 0–6 點就寢, 對話框 and 圖例; a room has no office picker, actions or style here.
  - Phone: the room keeps its ⋯ → 辦公室選項 sheet.

## Captures

| | Before | After |
|---|---|---|
| Desk, zh-TW, light | `before-desk-light-zh-TW-1-office.png` | `after-desk-light-zh-TW-1-office.png`, open: `after-desk-light-zh-TW-2-options.png` |
| Desk, en, dark | `before-desk-dark-en-1-office.png` | `after-desk-dark-en-1-office.png`, open: `after-desk-dark-en-2-options.png` |
| Desk, reduced motion (open) | — | `after-desk-light-zh-TW-reduced-2-options.png`, `after-desk-dark-en-reduced-2-options.png` |
| Phone, zh-TW, light | `before-phone-light-zh-TW-1-office.png`, sheet: `before-phone-light-zh-TW-2-options.png` | `after-phone-light-zh-TW-1-office.png`, sheet: `after-phone-light-zh-TW-2-options.png` |
| Phone, en, dark | `before-phone-dark-en-1-office.png`, sheet: `before-phone-dark-en-2-options.png` | `after-phone-dark-en-1-office.png`, sheet: `after-phone-dark-en-2-options.png` |
| Hub room, desk (gear open, then closed with Esc) | a sheet opened from the gear (#4370) | `room-desk-zh-TW-light-2-options.png`, `room-desk-zh-TW-light-3-closed.png`, `room-desk-en-dark-2-options.png`, `room-desk-en-dark-3-closed.png` |
| Hub room, desk, a 340 px stage (Prism P2) | the dropdown ran past the stage's foot | `room-desk-zh-TW-light-short-340-2-options.png` |
| Fleet office, desk, a 520 px window | — | `after-desk-dark-en-short-2-options.png` |
| Hub room, phone (⋯ → 辦公室選項) | unchanged | `room-phone-zh-TW-dark-2-sheet.png`, `room-phone-en-light-2-sheet.png` |

## Checks

`scripts/manual/smoke/smoke-office-toolbar-m3556.mts` (ui-gate, HP 19756) passes 7 cases; its output is `result.json`.

- **Desk:**
  - the bar is one row, with scope on the left and ⚙ on the right;
  - no option sits in the row;
  - the dropdown holds the six items, isn't modal, and has one label style and no buttons;
  - a tick applies while it stays open;
  - a click elsewhere and Esc close it.
- **Reduced motion:** the note is under Drag and pat.
- **A 520 px window:** the last option is on screen and takes a click.
- **Phone:**
  - no desk row;
  - the sheet's order is right;
  - the pickers are at least 6 px apart.
- **Every case:** no sideways scroll and no page errors.

The room captures came from a scratch Hub rig (not in the repo). It recorded:

- the gear's `aria-expanded` true, then false after Esc;
- the dropdown's four items;
- no sheet on a desk;
- the phone sheet's four options.

**Prism's review (two fixes):**

- **P2, a room in a short stage.** The room's dropdown now hangs from the zoom stack's top, not from the gear, and it is never taller than the stage's room below it; a longer list scrolls.
  - On a 340 px stage, the earlier head put the last option at 382–414 px against the stage's 400 px foot, so it was clipped.
  - Now it sits at 190–222 px, inside the stage, and takes a click.
- **P3, Esc focus.** Esc from inside the dropdown hands focus back to its button (⚙ or the room's gear). The rig shows `focusOnGear` false on the earlier head and true now; the unit tests cover both offices.
