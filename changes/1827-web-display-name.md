---
section: Changed
---
- **The web chat says who is writing (#1827).** Sign in with a code from `/web` and the agent recognises you as the Discord or Telegram account it was sent to. Your messages arrive as `[user:<name> via web, id:<your user id there>]` instead of `web-user`. This is for recognition only: a web message grants no permission.
  - The name is your account's display name, unless you choose another under **Settings → Preferences → Your name**. It follows you to every device, and is checked so it can't pose as another platform, user, agent or bot.
  - The same name and id are used in the topic echo, ClassicBot room logs, reply buttons and polls (one ballot per account, on the web or the platform), and tasks.
  - Signed in with an `agend web` code: `web-user`, as before.
