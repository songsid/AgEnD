# M-3680: contact permissions and held requests over the public link (real app)

**Root cause.** Fleet › Authorizations (授權), an agent's Permissions tab and Needs you's Approve read and write `/ui/api/contact-authorizations…` and `/ui/api/instances/<n>/contact-permissions…`. Those routes were missing from the public link's route list (`isPublicWebRoute`). The fixed link's gateway answered 404, and the page could only say "Couldn't load permissions" (無法載入權限). That breaks decision 7933bf90: an admin session gets the same features on every link. The routes are now on the list. The handler still admits only a verified administrator, asking the authority on every request. `tests/contact-auth-public-link-m3680.test.ts` proves it through the real gateway: each route is dispatched, where before it got a 404.

**These captures** come from the real web app (`scripts/manual/smoke-fixture`) with a synthetic held request ("Example lead" → "Example worker"), taken headless with Chromium. The fixture is the local dashboard, which already worked; it shows the pages that now also work over the link, plus the new message. Script: `scripts/manual/contact-auth-link-m3680/browser.mts`. `receipt.json` lists the commit (its `src` clean), every check and each PNG's sha256.

| What | Capture |
|---|---|
| **Authorizations.** The held request, with its decision buttons | `*-1-authorizations.png` |
| **Needs you.** The same request, approvable there | `*-2-needs-you.png` |
| **Permissions tab** of the agent whose sends are held: the retained origin and its Clear button | `*-3-permissions.png` |
| **No verified administrator** behind the session (a browser not yet authorized over a link): Authorizations says "Permissions and contact requests need a verified administrator. Verify your identity in Sign-in status (Authorize this browser), then try again." (權限和聯絡申請需要已驗證的管理員。請先在「登入狀態」按「授權這個瀏覽器」驗證身分，再試一次。) | `*-4-verify-authorizations.png` |
| **The same on the Permissions tab** (before, it said "Only this agent's managers can see its permissions") | `*-5-verify-permissions.png` |

Combinations: desk en light, phone zh-TW dark.
