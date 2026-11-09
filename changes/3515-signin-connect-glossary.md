---
section: Changed
---
- **Signing in again on the AgEnD computer, connecting AI accounts, and named codes (#3515).**
  - The sign-in page no longer tells you to send /web when no chat is connected yet. Before, a fresh install whose bot was set up but not connected was told to.
  - Opened on the AgEnD computer itself, the sign-in page says how to sign in again there: the 「AgEnD 儀表板」 desktop shortcut on Windows, or `agend web` in a terminal.
  - AI provider accounts are now *connected*, never "signed in with a device code". Settings → Agents → **AI accounts** shows connected / not connected with **Connect account** / **Reconnect**. You finish on the provider's official website, and the provider's code is called the **authorization code**. Needs you (including a CLI waiting at its own login screen: "Waiting to connect its AI account"), the chat `/backend` picker, setup and `/login` use the same words.
  - In 繁體中文, a code is never just 「代碼」. The dashboard's one-time code is 「裝置登入碼」, a provider's is 「授權碼」, the setup page's is 「設定碼」, and an exit status is 「結束碼」.
