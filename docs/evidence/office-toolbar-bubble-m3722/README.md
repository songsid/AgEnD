# M-3722: Fleet's phone header fits all its tabs; a lone caller's bubble clears the Help desk name (real app)

Both problems existed on release 0a7380f5 and were found in #4449's captures.

**(a) Phone Fleet header.** At 390px, Fleet's eight tabs (Tasks, Schedules, Teams, Org chart, Cache, Usage, Authorizations, Host health) shared one row with ☰. They needed 420px in en and 398px in zh, against 306px available, so the last ones were cut off; on Host health the row had even scrolled Tasks off the left edge. Now the phone header is two rows:
- ☰ and this page's name;
- every tab as an icon, in equal columns across the width, each at least 44 × 44 px. A tab's name stays its accessible name.

Nothing scrolls off, in either language. The desk header is unchanged.

**(b) One agent calling.** The caller stands at the height of the Help desk (求救區) name. So every spot's tail met the name, and the bubble fell back to covering it (M-3648: a name never keeps a call out). Now an area's name keeps a bubble's box off it, with 3px of air, either a row up or with the box on the tail's left. The tail may cross the name, and a crossed name is written again over the tail. A call with no clear spot still covers a name (M-3648, unchanged).

**Captures.** From the real web app (`scripts/manual/smoke-fixture`), taken headless with Chromium. The same script, `scripts/manual/office-toolbar-bubble-m3722/capture.mts`, was run on each checkout:
- `before/`: release 0a7380f5, 42 of 78 checks. Its phone checks fail: tabs off-screen, under 44px, and the header doesn't name the page.
- `after/`: this branch at 84cec8e9a, 78 of 78.

Tasks shows a scratch task board of three made-up cards in an "Example project".

Each `receipt.json` lists the commit (its `src` clean), every check, the measured tab geometry and each PNG's sha256.

| What | Files (in `before/` and `after/`) |
|---|---|
| Phone Fleet: Tasks, Org chart and Host health; en and zh-TW, light and dark | `m3722-phone-{light,dark}-{en,zh-TW}-{tasks,org,host-health}.png` |
| Office, one agent calling, desk, every zoned style (Studio, Cozy, Guild, School), en and zh-TW | `m3722-desk-{light-en,dark-zh-TW}-office-{studio,cozy,guild,school}.png` |
| Desk Fleet pages (canvas org chart, reduced motion), for the unchanged-desk check | `m3722-desk-{light-en,dark-zh-TW}-{tasks,org,host-health}.png` |

**Desk unchanged.** Before and after, pixel by pixel:
- 4 of the 6 desk frames are identical.
- `desk-light-en-org` (10 pixels) and `desk-dark-zh-TW-org` (8 pixels) differ only at the sidebar's live status dots, around x 238–282. Those spots also differ between two runs of the same commit.

**Tests.**
- `tests/fleet-phone-header-m3722.test.ts`: the phone header names the page, and the desk header still says Fleet.
- `tests/office-call-clears-name-m3722.test.ts`: every zoned style, en and zh-TW, each calling state, drawn as the page draws it. The call is drawn, its box covers no area name, and a name its tail crosses is written again. Also covers placeBubbles' order and M-3648's fallback, and the flipped box's geometry.
