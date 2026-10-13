---
section: Changed
---
- **Telegram `/web`: sign in without leaving the bot's private chat (#1742).**
  - A fleet admin who opens the bot's DM through the "Start privately →" link (`/start web`) now gets the /web menu right there. Choosing LAN or the public link sends the sign-in code to that same chat, so there is no trip back to General. The menu belongs to the same General as `/web` there, with the same admin checks, and its buttons work only in that DM for that admin.
  - When `/web` cannot reach you privately, the message now walks through it: ① open the private chat (the button, when the bot's name is known) ② press Start ③ choose the link there. It never tells you to send a bare `/start`, which starts a separate ClassicBot agent. Without a known bot name it says to send `/start web`.
  - Within 10 minutes of that message, your next bare `/start` in the bot's DM (Telegram's START button) is read as `/start web`, once. Every other `/start` behaves as before.
  - If the message's buttons could not be updated, the outcome is posted with its "Start privately →" button instead of without it.
  - Discord is unchanged.
