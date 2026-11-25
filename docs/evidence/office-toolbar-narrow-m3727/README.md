# M-3727: the Office's phone bar keeps ⋯ on screen at 320–360px (real app)

**Before** (release 34caa085a, found in #4453's captures). On a phone, the Office's bar above the stage holds Find (at least 88px), the Canvas / List / Office switch and a 44px ⋯ in one row that doesn't wrap. Together they need about 342px in en and 325px in zh. At 320px the row has 296px, so ⋯ went partly or wholly off-screen; at 360px in en it overran its bar.

**Now.** Under 370px the bar wraps: Find takes the first row, and the switch and ⋯ (kept at the right) take the second. Wider phones keep the one-row bar from M-3253. The area pills under the stage (Whole office, the work area, the lounge, the Help desk) were already a scrolling row that fades at the edge it cuts. The captures check that they are reachable: either all whole, or scrollable with their fade, and the last one whole once scrolled.

**Captures.** From the real web app (`scripts/manual/smoke-fixture`), taken headless with Chromium, with one agent calling (a held request) and one working, so there are four pills. The same script, `scripts/manual/office-toolbar-narrow-m3727/capture.mts`, was run on each checkout:
- `before/`: release 34caa085a, 78 of 86 checks. "⋯ is whole on screen" and "every bar control whole on screen" fail at 320px in en and zh, and at 360px in en.
- `after/`: this branch at 2e9230d55, 86 of 86.

Each `receipt.json` lists the commit (its `src` clean), every check, the measured geometry of each bar control and the pills, and each PNG's sha256.

| What | Files (in `before/` and `after/`) |
|---|---|
| Phone 320, 360 and 375px; light and dark; en and zh-TW | `m3727-phone-{light,dark}-{en,zh-TW}-{320,360,375}.png` |
| Desk, the same page | `m3727-desk-light-en.png`, `m3727-desk-dark-zh-TW.png` |

**Desk unchanged.** The rule sits inside the phone media block, under 370px. The two desk frames differ before and after only inside the animated office picture (a few hundred pixels). Two runs of the same commit differ in the same area by 376 to 910 pixels; the bar and everything else are identical.

**Test.** `tests/office-toolbar-narrow-m3727.test.ts` pins the rule, its place in the phone block, and the one-row bar above 370px.
