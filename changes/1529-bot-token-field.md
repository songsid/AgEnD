---
section: Fixed
---
- **Settings: adding a connection never replaces an existing one (#1529).** The setup wizard matched an existing connection by its token variable and overwrote it, so adding a Discord bot after a Telegram one could silently replace the Telegram connection. Every new connection now gets its own id (`discord`, `discord-2`, …) and its own token variable, and one that would take another's is refused.
