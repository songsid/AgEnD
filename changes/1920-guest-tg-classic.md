---
section: Security
---
- **Web: guests can now also ask for a sign-in code from a Telegram DM or a ClassicBot room (#1920).**
  - **Telegram, when the DM fails:** a guest whose code couldn't be sent privately gets a link to start a chat with the bot. Pressing Start there sends their guest code to that DM, as #1742 does for admins.
  - **In a ClassicBot room:** `/web` typed in a room (in a Telegram group, `/web@YourBot`) works for guests as it does in a fleet topic. The code still goes privately, and only a short line is posted in the room. Discord rooms use the `/web` slash command, in the bot's own server.
