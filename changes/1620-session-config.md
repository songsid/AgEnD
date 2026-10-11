---
section: Added
---
- **Web: choose how long a dashboard sign-in lasts (#1620).** For the dashboard reached directly (on this computer, your LAN or a tailnet), `web.session.local.absolute_hours` and `web.session.local.idle_hours` in `fleet.yaml` set how long a sign-in lasts and how long it may sit unused — anywhere from 1 to 720 hours (defaults 12 and 2, unchanged). A public-link sign-in keeps its fixed 4 hours / 30 minutes. A change applies without a restart; making it shorter also signs out sessions that are now older than the new limit.
