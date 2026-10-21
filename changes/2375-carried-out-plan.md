---
section: Fixed
---
- **On macOS, `agend restart` no longer repeats "launchd already runs the job an interrupted update planned" after every update (#2375).** An update leaves a launchd plan behind; when launchd already runs the planned job, the plan is done, and it is now removed instead of being judged again (and announced) on every later restart.
