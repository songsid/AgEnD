# M-3722: Fleet's phone header fits all its tabs; a lone caller's bubble clears the Help desk name (real app)

Both problems existed on release 0a7380f5 and were found in #4449's captures.

**(a) Phone Fleet header.** At 390px, Fleet's eight tabs (Tasks, Schedules, Teams, Org chart, Cache, Usage, Authorizations, Host health) shared one row with ☰. They needed 420px in en and 398px in zh, against 306px available, so the last ones were cut off; on Host health the row had even scrolled Tasks off the left edge. Now the phone header is two rows:
- ☰ and this page's name;
- every tab as an icon, in equal columns across the width, each at least 44 × 44 px. A tab's name stays its accessible name.

Under 384px (360px and 375px phones) the row runs edge to edge, and under 352px it wraps into two rows of four, so every tab stays 44 × 44 (#4453 review). Each tab has its own icon: Cache, Usage and Host health no longer share the chart icon. The tab you are on is a flat pill tinted with the accent (14% into the background), with the icon in the accent: 5.9:1 against the header in light mode and 7.7:1 in dark. The grey tile alone was about 1.2:1 and 1.4:1 (the leader's capture check). A 3px line under it read as a raised key (the user, #4453), so there is no line, border or shadow, in light or dark.

Nothing scrolls off, in either language. The desk header is unchanged.

**(b) One agent calling.** The caller stands at the height of the Help desk (求救區) name. So every spot's tail met the name, and the bubble fell back to covering it (M-3648: a name never keeps a call out). Now an area's name keeps a bubble's box off it, with 3px of air, either a row up or with the box on the tail's left. The tail may cross the name, and a crossed name is written again over the tail. A call with no clear spot still covers a name (M-3648, unchanged).

**Captures.** From the real web app (`scripts/manual/smoke-fixture`), taken headless with Chromium. The same script, `scripts/manual/office-toolbar-bubble-m3722/capture.mts`, was run on each checkout:
- `before/`: release 34caa085a, 84 of 144 checks. Its phone checks fail: tabs off-screen, under 44px, the header doesn't name the page, three tabs share one icon, and the current tab is too faint.
- `after/`: this branch at 4fac07d04, 144 of 144.

Tasks shows a scratch task board of three made-up cards in an "Example project".

Each `receipt.json` lists the commit (its `src` clean), every check, the measured tab geometry and each PNG's sha256.

| What | Files (in `before/` and `after/`) |
|---|---|
| Phone Fleet: Tasks, Org chart and Host health; en and zh-TW, light and dark | `m3722-phone-{light,dark}-{en,zh-TW}-{tasks,org,host-health}.png` |
| Narrower phones (375, 360 and 320px), Org chart, en and zh-TW | `m3722-phone-{light-en,dark-zh-TW}-{375,360,320}-org.png` |
| Office, one agent calling, desk, every zoned style (Studio, Cozy, Guild, School), en and zh-TW | `m3722-desk-{light-en,dark-zh-TW}-office-{studio,cozy,guild,school}.png` |
| Desk Fleet pages (canvas org chart, reduced motion), for the unchanged-desk check | `m3722-desk-{light-en,dark-zh-TW}-{tasks,org,host-health}.png` |

**Desk.** The layout is unchanged; the only intended change is the three new tab icons, which the desk header also shows (beside their names). Before and after, pixel by pixel:
- Every desk frame differs by about 420 pixels, all within the header's tab row: those three icons.
- Outside that row, every desk frame is identical.
- Before these icons (at 84cec8e9a), 4 of the 6 desk frames were byte-identical, and the other two differed only at the sidebar's live status dots.

**Tests.**
- `tests/fleet-phone-header-m3722.test.ts`: the phone header names the page, and the desk header still says Fleet.
- `tests/office-call-clears-name-m3722.test.ts`: every zoned style, en and zh-TW, each calling state, drawn as the page draws it. The call is drawn, its box covers no area name, and a name its tail crosses is written again. Also covers placeBubbles' order and M-3648's fallback, and the flipped box's geometry.
