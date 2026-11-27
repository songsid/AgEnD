# #4583: Permissions and Authorizations when a verified administrator is needed (M-3864 R6)

These are real-app captures from the 2.4.0 release tip 9a934f4ef, packed as 2.4.0-beta.2701 and run as the user's systemd service in a scratch container with mock agents. The dashboard was loaded in a headless browser.

- **This PR's code.** Three changed modules (`contact-auth-strings.js`, `contact-authorizations.js`, `contact-permissions.js`, from b393d4568) are served in place of the shipped ones, and this PR's `.contact-verify` rules are appended to the shipped `app.css`.
- **Session.** The page uses a sign-in code from the AgEnD computer, so the browser has no chat identity.
  - **No chat identity** (`*-no-account-*`): the server's real answer.
  - **Authorize button available** (`*-authorize-button-*`): the same session, with only `GET /ui/authorization` answering `{ state: "not_verified", reason: "not_authorized" }`.
- **Pages.** `permissions-*` is agent m1 → Settings → Permissions. `authorizations-*` is Fleet → Authorizations.
- **Variants.**
  - **Desk light en:** 1280×860.
  - **Phone dark zh-TW:** 390×844 at 2×, touch, with the host's language preference set to zh-TW for the run and then set back.

| | desk light en | phone dark zh-TW |
|---|---|---|
| Permissions, Authorize button | `permissions-authorize-button-desk-light-en.png` | `permissions-authorize-button-phone-dark-zh-TW.png` |
| Permissions, no chat identity | `permissions-no-account-desk-light-en.png` | `permissions-no-account-phone-dark-zh-TW.png` |
| Authorizations, Authorize button | `authorizations-authorize-button-desk-light-en.png` | `authorizations-authorize-button-phone-dark-zh-TW.png` |
| Authorizations, no chat identity | `authorizations-no-account-desk-light-en.png` | `authorizations-no-account-phone-dark-zh-TW.png` |
