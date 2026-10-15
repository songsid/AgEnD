---
section: Fixed
---
- **Config: `web.access` gets a warning, and "/web disabled" says where fleet admins go (#1874).**
  - Who may run `/web`, `/update` and `/doctor` is the fleet admin list: `access.allowed_users` under the bot's channel. There is no `web.access` setting.
  - `agend validate` now warns about `web.access`, saying where the list really goes, and about any other unknown key under `web`. These keys were ignored silently before.
  - When the list is empty, the `/web` and `/update` replies name the exact key, such as `channel.access.allowed_users` or `channels[id: main].access.allowed_users`.
