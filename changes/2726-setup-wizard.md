---
section: Changed
---
- **The dashboard's Setup wizard no longer requires a working directory either.** In Settings → Setup wizard, a new agent's working directory may be left empty, as on the `agend setup` page. The agent then gets its own folder, `~/.agend/workspaces/<name>`, which the wizard shows under the field, and the plan names the full path. A directory you enter must still be absolute. In 繁體中文, the wizard now also shows the host's refusals (an agent name that is taken, a connection that exists, a token env that is reserved), the plan's warnings (a backend not installed) and the Discord channel list's errors in 繁體中文. An apply step that the setup host refused by code says so in words in both languages (#2726).
