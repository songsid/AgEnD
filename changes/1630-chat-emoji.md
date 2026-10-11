---
section: Added
---
- **Web chat: Discord server emoji show as pictures (#1630, part 3).** A message with `<:name:id>` or `<a:name:id>` (what a Discord custom emoji is in text) shows the emoji's picture when it belongs to a server the fleet's Discord bots are in. The picture comes from the dashboard itself, so the page never loads Discord; the list of known emoji is read once per page, and only when a message has one. Any other one stays as written. The sidebar's picture check is also stricter: one file under the dashboard's picture routes, never a path that climbs out of them.
