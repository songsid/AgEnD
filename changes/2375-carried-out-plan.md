---
section: Fixed
---
- **On macOS, `agend restart` no longer repeats "launchd already runs the job an interrupted update planned" after every update (#2375).** An update leaves a launchd plan behind. When launchd already runs the planned job, that plan has nothing left to activate: `agend restart` now restarts the job without the note. The plan record stays until the next update replaces it, as every update does.
