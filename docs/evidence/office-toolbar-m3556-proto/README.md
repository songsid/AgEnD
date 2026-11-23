# Fleet office toolbar: before and after (M-3556 prototype)

**A prototype for the user's look, not the final PR.** Built on #4370 (R1b) and #4374 (M-3547), because both change the same toolbar. Captured headless with Chromium on the smoke fixture: eight made-up agents and two stored offices, with no live provider, CLI or Fleet. The capture script is `scripts/manual/proto/m3556-capture.mts`.

## The change

- **Desk: one row.** On the left is what you're looking at: 辦公室 ▾, 顯示 ▾ and 成員. On the right are the actions: 編輯辦公室, 分享…, and **⚙ 顯示選項**. At 1366 px the bar is 30 px tall, down from 68 px (two rows).
- **⚙ 顯示選項** is a dropdown, not a modal, like 成員. The office stays in view, so a tick shows at once, and a click elsewhere or Esc closes it. It holds 風格, 隱藏暫停與停止的成員, 拖曳與摸頭 (with the reduced-motion note from M-3547 on its own line), 0–6 點就寢, 對話框 and 圖例.
- **Phone:** the ⋯ sheet keeps its tiles and 即時. Its items now follow the desk's order: scope first, then a **顯示選項** section, then the actions.
- **The Hub room office** already keeps these options behind a gear in its zoom stack (R1b). That gear opens the same option set, now in the same order.

| | Before | After |
|---|---|---|
| Desk, zh-TW, light | `before-desk-light-zh-TW-1-office.png` | `after-desk-light-zh-TW-1-office.png`, menu open: `after-desk-light-zh-TW-2-options.png` |
| Desk, en, dark | `before-desk-dark-en-1-office.png` | `after-desk-dark-en-1-office.png`, menu open: `after-desk-dark-en-2-options.png` |
| Desk, reduced motion (menu open) | — | `after-desk-light-zh-TW-reduced-2-options.png`, `after-desk-dark-en-reduced-2-options.png` |
| Phone, zh-TW, light | `before-phone-light-zh-TW-1-office.png`, sheet: `before-phone-light-zh-TW-2-options.png` | `after-phone-light-zh-TW-1-office.png`, sheet: `after-phone-light-zh-TW-2-options.png` |
| Phone, en, dark | `before-phone-dark-en-1-office.png`, sheet: `before-phone-dark-en-2-options.png` | `after-phone-dark-en-1-office.png`, sheet: `after-phone-dark-en-2-options.png` |
| Phone, reduced motion (sheet) | — | `after-phone-light-zh-TW-reduced-2-options.png`, `after-phone-dark-en-reduced-2-options.png` |

## Not done yet (the final PR)

- **Tests:** 25 page tests that reach into the old bar (the style picker, toggles, All offices) need to open ⚙ first.
- **圖例** becomes a tick in the menu.
- **The room's gear** should open this same dropdown, not a sheet, so both offices use one control.
- **Docs, skill, changelog, and a ui-gate smoke.**
