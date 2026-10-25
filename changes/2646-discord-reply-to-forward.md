---
section: Fixed
---
- **On Discord, a reply to a forwarded message now tells the agent what was forwarded (#2646).** When someone forwarded a message into a channel and then replied to it with an @mention, the agent got the reply with an empty reply-to: Discord keeps a forward's text and images in a separate part of the message, which AgEnD did not read for replies. Now the reply-to carries the forwarded text (or its embed's title and description), and the forwarded images arrive with the reply, as a reply's images already did. This works in fleet topics and ClassicBot channels. A forward on its own still never addresses the bot.
