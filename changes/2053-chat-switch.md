---
section: Changed
---
- **Web chat: switching back to a recent chat is near-instant (#2053).** The last four chats you opened are kept as they were drawn, and come back where you left them. Each message's Markdown is rendered once, not again on every redraw: about 320 renders per switch of 200 messages before, none on a revisit now.
  - Measured with a 4× slower CPU, 200 messages per chat: a revisit drew the whole thread in about 2.7 s on a desktop and 2.0 s on a phone; now about 0.5 s, with almost no long tasks.
