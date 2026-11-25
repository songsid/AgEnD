# M-3720: a restricted-mode suggestion doesn't put a ClassicBot room in the Help desk (real app)

**Before.** The office and the org chart (`fleet-org.js` `buildOrgView` → `orgState`) put an agent in "needs" whenever any Needs you item named it. Every unrestricted ClassicBot room gets the low-key "this room can switch to restricted mode" suggestion (`contact_restricted_suggestion`), so every such room sat in the Help desk (求救區). On 11-25 that happened to 馬斯克Bot. Needs you itself folds these suggestions into one quiet group.

**Now.** The office and the org chart skip that one suggestion. Every real call still counts: a held contact request, a failed delivery, a crash, a lapsed Hub share, a CLI waiting at its terminal (`tests/office-suggestion-not-a-call-m3720.test.ts`).

**These captures** come from the real web app (`scripts/manual/smoke-fixture`), taken headless with Chromium. The fixture's ClassicBot rooms are loaded through the real registry. None is restricted, so Needs you lists each room's suggestion. The one real call is a held contact request to "Example worker". Each case checks three things in the page, using the office's own `buildOrgView`:
- every room's suggestion is in Needs you;
- no room is drawn as "needs";
- "Example worker" is "needs".

`receipt.json` lists the commit (its `src` clean), every check (35/35), the rooms, each agent's state per case and each PNG's sha256. Script: `scripts/manual/office-suggestion-m3720/browser.mts`.

| Case | Capture |
|---|---|
| Desk and phone, en and zh-TW (the default style) | `m3720-desk-light-en.png`, `m3720-desk-dark-zh-TW.png`, `m3720-phone-light-en.png`, `m3720-phone-dark-zh-TW.png` |
| Each built-in style (#4415's lesson: calls on every style), desk en | `m3720-desk-light-en-pixel.png`, `-studio.png`, `-cozy.png` |

**Negative control.** The same script, run with `fleet-org.js` from the release branch, fails "no room is drawn calling for it" in every case: each room is "needs". That is the bug.
