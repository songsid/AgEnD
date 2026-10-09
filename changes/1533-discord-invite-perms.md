---
section: Changed
---
- **CLI: the persona bot invite uses the same permission set as Settings (#1533).** It adds Manage Channels, Attach Files and Use External Emojis, which the bot's calls need, and drops Manage Messages and Use Application Commands, which the bot does not need (slash commands come with the invite's applications.commands scope).
