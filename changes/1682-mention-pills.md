---
section: Added
---
- **Web chat: mentions look the way Discord and Telegram show them (#1682).** A user mention `<@id>` (or `<@!id>`) now shows as an **@name** pill instead of the raw token. Role mentions `<@&id>` and channel mentions `<#id>` show the same way, as **@role name** and **#channel**, and every pill shows its id on hover. Names come from what AgEnD already knows: the fleet's own bots (by their instance's name), people who have written to the fleet, and the Discord servers its bots are in. AgEnD makes no extra Discord request for them, and a page only gets the names of the mentions it is showing. An unknown one reads **@user**, **@role** or **#channel**, never the raw token. A Telegram **@username** gets the same look. Code spans and code blocks are left as written.
