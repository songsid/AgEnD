---
section: Security
---
- **Web: a public link can no longer create, edit or delete schedules (#1724).** Schedules run as messages to agents, so they are refused over a public link in the same way as teams (#1689): the routes are not offered there, and the server refuses them. A public link still lists schedules.
