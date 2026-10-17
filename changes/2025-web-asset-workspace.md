---
section: Fixed
---
- **Web asset tools work in an instance’s own managed workspace (#2025).** Picture and effect uploads, mod proposals, appearance previews and mod exports now accept the caller’s own `~/.agend/workspaces/<instance>` directory while retaining the working-directory boundary. Other instances’ workspaces and other AgEnD state remain refused, including through symlinks. Staging subdirectories are optional.
