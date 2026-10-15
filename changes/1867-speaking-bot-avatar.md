---
section: Changed
---
- **Web: an instance's avatar defaults to the bot it talks through (#1867).** If you haven't uploaded a picture, the web app shows the avatar of the instance's own persona bot when it has one. Otherwise it shows the bot it speaks through on Telegram or Discord, usually the General bot. Instances with no connection of their own use the General bot too. A bot without an avatar still falls back to the persona emoji, then the name's first letter. Only an instance's own bot gets the coloured ring.
