# M-3651: a guest's private /web code verifies who it is (real app)

These are captures of the real web dashboard: real web HTTP, sessions, preferences and DOM, served by `scripts/manual/smoke-fixture` with inert agents (Atlas, Beacon) and a synthetic guest account. They were taken headless with Chromium. Script: `scripts/manual/web-guest-verified-m3651/capture.mts`.

The verified guest is made by the same call auth-api makes after a private code's sign-in (`FleetManager.authorizeSignedInSession`). The fixture has no chat connection, so the DM with **Not me** isn't sent here. `tests/web-guest-verified-m3651.test.ts` covers it through the real `/auth/login`.

| What | Capture |
|---|---|
| **Signed in with the private code: verified as the account.** The session menu's role reads **Guest · Verified until …** (zh-TW **訪客 · 驗證有效至 …**). `/auth/session` gives the guest its `verifiedUntil`. Its messages would carry `web-guest`, never `web-verified` (checked). There's no Authorize line: a guest never gets a card. | `*-guest-verified.png` |
| **Not verified** (for example, a code that didn't go privately): **Guest** / **訪客**, as before. Its messages carry nothing. | `*-guest-not-verified.png` |

Combinations: desk en light, desk zh-TW dark, phone en light, phone zh-TW dark.

The time is the end of the authorization: the sooner of its hours (48 by default) and the guest's sign-in length (12 h by default). It is shown as a clock time, the same as an admin's "Verified until".

The image review found two layout issues in the desk English menu, both now fixed and checked:
- The longer role dropped under a lone **Role** label. It now wraps beside its label (`.pop .role strong`).
- The clock time split across lines (09:16 / AM). It is now kept together with a no-break space.

Two new checks cover these: the role starts beside its label, and the time stays on one line. The time check fails on the commit before the fix, with the time on 2 lines.

`receipt.json` lists the commit (its `src` clean), each check (52/52) and each PNG's sha256.

Re-taken on 11-25 at f95679249 (the zh role reads 訪客 · 驗證有效至 …), after the release tip 8173deb6b was merged in (#4433, #4435, #4438, #4447, #4448, #4449 and #4453 had landed in the same web authority, session and receipt code): 52/52, unchanged.
