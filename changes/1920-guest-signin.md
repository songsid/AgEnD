---
section: Security
---
- **Web: people who aren't admins can now sign in to the web as guests (#1920). This is off until `web.guests.enabled: true`.**
  - **How:** a guest sends `/web` where they already chat: General, an agent's topic, or a Discord slash command anywhere. The sign-in code comes privately, by DM or, for a Discord slash command, as an answer only they see. It's never posted where they asked. They can ask at most once a minute. For now the code works on the dashboard reached directly, not over the public link.
  - **What they see:** only the agents they can already use in chat. If there are none, no code is sent. On an `open` connection that has no agents named for guests, they're told to ask an admin.
  - **Admins stay aware:** every guest sign-in is posted in General, with who it was and how many agents they can reach. This happens even with `web.notify_login: false`, which covers only your own sign-ins.
  - **Signing out:** `/web revoke` from a guest signs out only their own guest sessions. From an admin it still signs out everyone.
  - **Nobody cancels anyone else's code:** each account has one sign-in code at a time, and asking again replaces only their own. A guest never cancels another guest's code or an admin's. If too many guest codes are waiting to be used (32), new guests are asked to try again in a few minutes.
  - **In the channel:** a guest's message copied from the web shows "(guest)" after their name.
