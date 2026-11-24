# M-3668: finished work off the board (real app)

These are captures of the real web app and task board (`scripts/manual/smoke-fixture`), with a scratch scheduler database of made-up cards. The board's real data stays off GitHub. The captures were taken headless with Chromium, with motion reduced. Script: `scripts/manual/task-board-archive-m3668/capture.mts`. `receipt.json` lists the commit (its `src` clean), every check (51/51) and each PNG's sha256.

**The fixture.** "Example project" holds 60 main tasks finished over the last 11 days: 40 of them in the last 3 days, and a few cancelled. Three are at work (In progress, Blocked, To do). With the default `archive_after_days` (3): 37 are on the board's Done column, 20 are archived, and 45 finished this week.

| What | Capture |
|---|---|
| **Home.** The project's tile says "20 archived" (已封存 20 張); its main tasks and % leave them out | `*-1-home.png` |
| **The board.** The Done column shows its newest 20 of 37, "45 this week" (本週 45 張) beside its title. On a phone, where columns have no heads, the count stands over the Done cards. The header has "Archived · 20" (已封存 · 20), on its own row on a phone | `*-2-board.png` |
| **Show more.** "Show 17 more" (再顯示 17 張) under the Done column's cards: the rest, up to 20 at a time | `*-2b-show-more.png` |
| **The Archive.** "Example project · archived": newest first, with the lead line (still found by search and by number; To do reopens), "Assigned to" and the count | `*-3-archive.png` |
| **Search.** An archived card's hit says "Archived" (已封存) | `*-4-search.png` |
| **A card's page.** "Archived" beside its status | `*-5-card.png` |
| **Settings** (#4428 review). Shared agent settings → Advanced → "Archive finished cards after" (完成的卡片封存於): 3 days, marked "default" | `*-6-settings.png` |
| **Settings, refused.** 2.5 typed: "A whole number of days from 0 to 3650." (請輸入 0 到 3650 之間的整數天數。), and the Save bar asks to fix it | `*-6b-settings-refused.png` |

**Checked, not pictured** (#4428 review): one archived main task has a step finished an hour ago. The board read leaves that step out, and it carries the `epoch`. The public link's hiding in the Archive is covered by tests (`tests/task-board-archive-web-m3668.test.ts`), since this fixture has no public link.

Combinations: desk en light, desk zh-TW dark, phone en light, phone zh-TW dark.

**Measured, not changed:** on a phone the release's own project head squeezes a project's name beside its buttons ("Exampl/e/project" in English, measured the same without this change). `receipt.json` has `nameLines`.
