# M-3563: the Hub sign-in is a login the browser keeps as typed (real app)

The real Hub and its real UI, headless Chromium (desk 1366×900, zh-TW light and en dark). "Before" is plain
release/2.3.5-alpha f1f18f775, "after" this branch. In the page, a spy on `navigator.credentials.store` records what the
page hands the browser's password manager; headless Chrome has `PasswordCredential` but shows no prompt.

| | Before | After |
|---|---|---|
| 帳號 / 密碼 fields | `autocomplete` only, no `name` | `name="username"` / `name="password"`, `autocomplete` username / current-password |
| sign-in refused for `admin@example.com` | 「帳號或密碼不正確。」 | 「帳號或密碼不正確。帳號只要填 @ 前面的部分（例如 alex），不是電子郵件地址。」 |
| sign-in that works, as `admin` | nothing handed to the password manager | one password credential, id `admin` (exactly as typed) |

Pictures: `*-1-at-hint.png` (the refused `admin@example.com`). That Chrome / Edge then offers the saved Hub login
instead of the email from its saved personal info can only be seen in the person's own browser, after one sign-in.
