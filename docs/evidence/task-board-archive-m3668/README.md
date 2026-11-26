# M-3668: finished work off the board (real app)

These are captures of the real web app and task board (`scripts/manual/smoke-fixture`), with a scratch scheduler database of made-up cards. The board's real data stays off GitHub. The captures were taken headless with Chromium, with motion reduced. Script: `scripts/manual/task-board-archive-m3668/capture.mts`. `receipt.json` lists the commit (its `src` clean), every check (77/77) and each PNG's sha256. On a phone, the Settings field (archive after N days) is measured as a 44px tap target.

**The fixture.** "Example project" holds 120 main tasks finished over the last 4 weeks: 40 of them in the last 3 days. Every 13th is cancelled (M-8, M-21, M-34, …); cancelled cards are not in the Done column, so its numbering skips them. Three more are at work (In progress, Blocked, To do). With the default `archive_after_days` (3), the first combination starts with:
- 37 cards in the Done column;
- 80 archived;
- 48 done this week, 11 of them archived (37 + 11 = 48).

Each combination reopens one archived card, so the later ones show one archived card fewer (79, 78, 77) and one fewer done this week.

| What | Capture |
|---|---|
| **Home.** The project's tile says "80 archived" (已封存 80 張); its main tasks and % leave them out | `*-1-home.png` |
| **The board.** The Done column shows its newest 20 of 37. Under its head, over its cards: "48 done this week · 11 archived" (本週完成 48 張 · 其中 11 張已封存), which a narrow column breaks only at the "·" (in the head it squeezed the title to 「完 / 成」). The 37 in the column plus the 11 archived make the 48. A phone draws no column heads; the line stands there the same way. The header has "Archived · 80" (已封存 · 80), on its own row on a phone | `*-2-board.png` |
| **Show more, before.** "Show 17 more" (再顯示 17 張) under the Done column's 20 cards | `*-2b-show-more-before.png` |
| **Show more, after.** Scrolled to the join: the 20th card, then the first of the 17 appended (37 in all), and the button gone. M-21 is not missing: it is cancelled, and the Done column shows done cards only | `*-2c-show-more-after.png` |
| **The Archive.** "Example project · archived": newest first, a page of 50 ("50 / 80"), with the lead line, "Assigned to", and **when each finished as a date and time** ("Done Nov 21, 14:05" / 「11月21日 14:05 完成」). A relative "3 days ago" rounded 3.3 days down and read as contradicting "more than 3 days"; the relative time is now the tooltip | `*-3-archive.png` |
| **The Archive's next page.** "Show more" (顯示更多): all 80 | `*-3b-archive-next-page.png` |
| **Filtered by assignee.** "Assigned to" set to one agent: only theirs | `*-3c-archive-filtered.png` |
| **Reopened from the Archive.** The newest archived card, opened from the list, then **Reopen** (重新開啟; the card's button said 重新打開 before, now the same word as the Archive's lead): it is in progress again, off the Archive. The board then says one archived fewer (checked) | `*-7-reopened.png` |
| **Search.** An archived card's hit says "Archived" (已封存) | `*-4-search.png` |
| **A card's page.** "Archived" beside its status | `*-5-card.png` |
| **Settings** (#4428 review). Shared agent settings → Advanced → "Archive finished cards after" (完成的卡片封存於): 3 days, marked "default" | `*-6-settings.png` |
| **Settings, refused.** 2.5 typed: "A whole number of days from 0 to 3650." (請輸入 0 到 3650 之間的整數天數。), and the Save bar asks to fix it | `*-6b-settings-refused.png` |

**Checked, not pictured** (#4428 review): one archived main task has a step finished an hour ago. The board read leaves that step out, and it carries the `epoch`. The public link's hiding in the Archive is covered by tests (`tests/task-board-archive-web-m3668.test.ts`), since this fixture has no public link.

Combinations: desk en light, desk zh-TW dark, phone en light, phone zh-TW dark.

**Measured, not changed:** on a phone the release's own project head squeezes a project's name beside its buttons ("Exampl/e/project" in English, measured the same without this change). `receipt.json` has `nameLines`.
