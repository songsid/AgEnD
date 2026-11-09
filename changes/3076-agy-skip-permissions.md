---
section: Fixed
---

- **Antigravity honours `skipPermissions: false` (#3076).** Launch omits `--dangerously-skip-permissions` when the instance is set that way, matching the other CLI backends. Folder-trust is still auto-answered; per-action approvals are not.
