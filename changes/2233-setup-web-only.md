---
section: Added
---
- **Set AgEnD up without a bot: "Web only (no bot)" on the setup page (#2233).** The browser setup page (`agend setup`, and the Windows installer's last step) has a third choice next to Telegram and Discord. It needs no bot token, no admin ID and no Verify: it writes your first agent and no chat connection, and you use AgEnD from its web dashboard. Sign in there with `agend web --code` on the machine; backend CLIs can be signed in from the dashboard as well. Discord or Telegram can be added later in Settings. The Windows installer names the choice, and its closing summary says "web dashboard only" instead of claiming a chat app is connected.
