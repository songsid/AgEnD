---
section: Fixed
---
- **Web app: Discord custom emoji show in the status-emoji editor again (#1520).** In Settings → Connections → Discord → Status emojis, every server emoji appeared as a broken image, because the page's security policy refused Discord's emoji CDN. Panels now allow images from exactly `https://cdn.discordapp.com/emojis/` and nothing else from Discord.
