---
section: Fixed
---
- **Quickstart "Add allowed users": supports `channels`-shaped files.** Extracted as `addAllowedUsersToConfig()` (exported). When `fleet.yaml` uses the `channels:` array shape, correctly reads and updates the chosen connection's `access.allowed_users`, and never writes a phantom `channel:` key. Multi-connection files show the connection `id` and `group_id` for disambiguation. (#1490 P2)
- **Quickstart "Overwrite (start fresh)": backup is fail-closed.** Extracted as `backupFleetConfig()` (exported, async, throws on failure). If the backup cannot be written, the overwrite is aborted and an error is printed — the user is never left without their config while believing a backup exists. (#1490 P2)
