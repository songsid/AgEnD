---
section: Security
---
- **Web: a guest's agents now come from what they can already use in chat, and guest sessions have their own limits (#1920). No guest can sign in yet.**
  - **Which agents:** checked on every request. A guest gets the agents of the connection that already lets them chat there, or their own Telegram private room. An `open` connection gives guests nothing until an admin names its agents in `web.guests.open_instances`. An admin can narrow one guest further with `web.guests.narrow`.
  - **When access ends:** if a guest is removed from the connection's access, or narrowed to nothing, their web session ends on their next request. Turning `web.guests.enabled` off ends every guest session; turning it back on revives none.
  - **Session limits:** 12 hours, or 2 hours idle, by default (`web.guests.session`), never longer than the dashboard's or the public link's own limits. Guests have their own room in the session list, so a guest signing in never signs an admin out.
