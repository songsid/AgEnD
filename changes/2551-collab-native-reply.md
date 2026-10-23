---
section: Fixed
---
- **In a ClassicBot room in collab mode, a native reply to a bot's message reaches that bot again (#2551).** Since agents' replies became real Discord replies (#2456), another fleet's bot answering with `reply_to` was never delivered: the room only counted a `<@bot>` mention in the text. A bot's native reply to one of this bot's own messages now counts as addressed to it. A reply to that bot's message pings it explicitly. To prevent two agents bouncing replies forever, a reply to a message that itself answered a bot doesn't trigger; an @mention still does. Fleet topics and Telegram were not affected.
