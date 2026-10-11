---
section: Changed
---
- **Settings: status-emoji pictures come from the dashboard itself (#1630).** The status-emoji editor's server-emoji grid and preview used to load Discord's CDN in your browser, and the dashboard's content policy allowed `cdn.discordapp.com/emojis/` for that. They now come from the dashboard's own cached route, the same one web chat uses, and the policy no longer allows any remote image: Discord never sees your address when the editor is open. An emoji from a server the fleet's bots are not in shows as its `:name:`. Agents' `list_emojis` image links are unchanged.
