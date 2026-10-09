---
section: Fixed
---
- **Quickstart "Add allowed users": supports `channels`-shaped files.** When `fleet.yaml` uses the `channels:` array shape, "Add allowed users" now correctly reads and updates the chosen connection's `access.allowed_users`, and never writes a phantom `channel:` key into the file. (#1490 P2)
- **Quickstart "Overwrite (start fresh)": backs up `fleet.yaml` before replacing it.** A `fleet.yaml.bak-<timestamp>` copy is written atomically before overwriting. The prompt text mentions the backup path. (#1490 P2)
