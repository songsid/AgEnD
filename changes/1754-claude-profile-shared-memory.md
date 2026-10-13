---
section: Fixed
---
- **Instances on a Claude credential profile keep the shared auto-memory (#1754).** A named profile has its own `projects/`, so Claude Code's memory for the repository started empty there, apart from every other instance's. Each profile launch now links the profile's memory folder for the instance's repository to the shared one under `~/.claude` (or your own `CLAUDE_CONFIG_DIR`). The key is the repository root, and a git worktree counts as its main checkout, as Claude itself keys memory. Conversations stay per profile. A profile memory folder that already holds notes is never replaced: it is left as it is and a warning is logged. Instances without a profile launch exactly as before.
