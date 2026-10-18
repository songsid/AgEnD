---
section: Fixed
---
- **Web chat: emoji no longer show as boxes (#1630).** Every font the dashboard uses, each agent theme's font included, now ends with the system's colour emoji fonts (Segoe UI Emoji, Apple Color Emoji, Noto Color Emoji).
  - A Discord server emoji whose picture can't be loaded reads `:name:` instead of an empty box. One the dashboard doesn't know reads `:name:` too, never the raw `<:name:id>`. The page still never loads anything from Discord.
