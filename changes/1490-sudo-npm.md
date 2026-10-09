---
section: Fixed
---
- **`retireSystemCopy`: resolves npm's absolute path before passing it to `sudo`.** Previously `sudo -n npm uninstall` used the bare `npm` command, which sudo resolves via its `secure_path` — potentially finding a different npm or none at all. The command now runs `sh -c "command -v npm"` first (using the same PATH the runner operates with) and passes the absolute path to `sudo`. If npm cannot be resolved, the removal is skipped with a clear message. (#1490 P3)
