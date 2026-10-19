---
section: Fixed
---
- **Deleting an agent from web Settings works again (#2168).** In **Settings → Agents**, **Delete agent** then **Apply changes** did nothing, and the page said `unsupported_sensitive_effect`. An agent with a description, a display name or a custom key was refused before its confirmation was even asked for. The chat's own **Delete** had the same problem.
  - **Now:** the change waits for a fleet admin's confirmation in General (or `agend settings confirm <id>`), and the confirmation reads "<agent>: deleted". Once it's confirmed, the agent is stopped and removed exactly as `delete_instance` removes it: its schedules and team places go too, and no AgEnD restart is needed.
  - **Errors in words:** a change Settings can't apply now says why in words instead of a bare code.
