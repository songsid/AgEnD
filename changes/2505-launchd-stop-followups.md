---
section: Fixed
---
- macOS `agend stop` follow-ups (#2505). When launchd still has the job after the wait, the message is now in the fleet's language. A `launchctl bootout` that blocks past its own timeout now waits for the job to unload instead of falling back to stopping the fleet by its PID.
