---
section: Changed
---
- **Skill: credential-profiles updated for Claude Code profile usage rows and manual conversation copy (#1753).** The skill now reflects that Claude Code profiles have their own `Claude (<profile>)` usage rows (since #1713); the stale "no rows yet" note is replaced with the correct behaviour, including the "Not logged in" row a never-signed-in profile shows. Two new sections cover what to do manually until automation lands: "Keep the Claude conversation when switching" (stop → copy `.jsonl` + checkpoint folder → touch → start → verify) and "Shared memory" (symlink the empty `memory` dir to the default profile's copy).
