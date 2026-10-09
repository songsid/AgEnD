---
section: Changed
---
- **Telegram forum-root commands have a fixed owner:** bare commands use the
  primary connection's General in that group, or the first configured same-group
  General when the primary has none there. The selected bot's admin list applies
  regardless of which sibling receives the message first; a stopped or unresolved
  owner never falls back to another bot. Use `/restart@ThatBot full`,
  `/update@ThatBot`, or that bot's own General topic to address a different bot.
  Ordinary messages and existing Classic commands keep their routing. (#1490)
