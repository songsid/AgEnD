---
section: Fixed
---
- **Telegram `/web` explains a failed public link correctly (#1742 follow-up).** When the sign-in link fails before the bot has tried to message you, for example because the public link cannot start, the message now says that the link could not be started and asks you to run `/web` again. It no longer tells you to open a private chat, which wouldn't help. The private-chat steps, the "Start privately →" button and the 10-minute `/start` window now appear only after a private message was actually tried and could not be delivered.
