---
section: Security
---
- **Web: a guest can chat with its own agents (#1920). No guest can sign in yet.**
  - **What a guest can do:** send a message, attach files, click a reply's buttons and press Cancel, as a member of that topic or room can on the platform, but only for the guest's own agents. Buttons work only on a reply the guest can see.
  - **What the agent sees:** for a guest's message and for a guest's button click, the agent sees `[user:<name> via web (guest), id:<their account id>]`. That is recognition only, like every web message; it never counts as a verified person.
  - **No commands:** a guest never sends a command. Text that starts with `/` is refused, so nothing like `/raw` gets through.
  - **Read-only guests:** `web.guests.chat: false` makes guests read-only.
  - **Preferences and name:** a guest reads the host's look (theme, language), but no preference that names an agent: not the sidebar's order, favourites, card sizes or the sidebar widget, and not on the page either. It can't change preferences yet. It can set its own web name.
