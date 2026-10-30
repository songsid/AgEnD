---
section: Changed
---
- **Telegram: strangers no longer see the ClassicBot command menu, and their commands get no answer (#2870).**
  - The `/` menu (`/start`, `/stop`, `/model`, …) now shows only in the chats ClassicBot serves: its rooms, and the ids in `classicBot.yaml`'s `allowed_users`, `admin_users` and `allowed_groups`.
  - Every other chat sees no menu. The broad Telegram menu scopes are written empty, so the old list doesn't linger.
  - A chat General allows gets the menu at once.
  - In a private chat, a stranger's commands other than `/start` are not answered at all. `/start` still asks General for access.
  - Allowed users, ClassicBot and fleet admins, existing rooms and groups behave as before. The fleet group's menu and the bot's description are unchanged.
