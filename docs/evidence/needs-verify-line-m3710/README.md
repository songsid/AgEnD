# M-3710: Needs you tells an unverified browser that contact requests wait (real app)

**Before.** With no verified person behind an admin session (Authorize this browser not done, or run out), Needs you left pending contact requests out without a word. That held on every link, this computer included: the requests are shown only to a verified administrator. On 11-25 a pending request was in no list, and the user could not see it.

**Now.** That session gets one line: how many requests wait (the count only, never which, who or what), with this browser's own Authorize this browser chip. Where it can't be authorized, the chip says why. Once the account confirms in its DM, Needs you is sent again, and the requests themselves (Approve once / Decline) replace the line. A verified administrator sees the same list as before. A read-only session gets no line, and neither does any session when nothing is pending.

**These captures** come from the real web app (`scripts/manual/smoke-fixture`), taken headless with Chromium. Two synthetic contact requests are held ("Example lead" → "Example worker"). The browser is signed in as a chat account that has not authorized it. Only the Discord side is stubbed: the agents sit on a "demo" Discord connection, and the signed-in accounts are its Fleet admins. Frame 3 goes through a real public link (FleetManager's PublicWebLink and gateway, with the tunnel stubbed). Script: `scripts/manual/needs-verify-line-m3710/browser.mts`. `receipt.json` lists the commit (its `src` clean), every check (62/62: on a phone, Authorize this browser is measured as a 44px tap target; the header counts the line as its 2 requests, before and after verifying; frame 2 is scrolled so the first request's Approve once and Decline are both in view) and each PNG's sha256.

| What | Capture |
|---|---|
| **This computer, not verified:** "2 contact requests need a verified browser" (有 2 個聯絡申請需要已驗證的瀏覽器) with Authorize this browser, and no request named | `*-1-local-unverified.png` |
| **The same browser after the account's Confirm:** the two requests with Approve once / Decline (核准這一次 / 拒絕), and no line | `*-2-local-verified.png` |
| **Over the public link, not verified:** the same line. The picture matches frame 1 because a headless shot has no address bar; the receipt records the page's `https://…trycloudflare.com` address (`linkPage-*`) | `*-3-link-unverified.png` |

Combinations: desk en light, desk zh-TW dark, phone en light, phone zh-TW dark.

Tests: `tests/needs-verify-line-m3710.test.ts` covers who gets the line (localhost, the fixed link, verified, read-only, nothing pending), the real FleetManager's count, the refresh after authorization (and that a failing refresh never fails the authorization), and the panel in en and zh-TW.
