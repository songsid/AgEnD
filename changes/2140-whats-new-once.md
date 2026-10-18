---
section: Fixed
---
- **The `[system:whats-new]` notice is sent at most once (#2140).** On long-lived Claude sessions it was sent again before almost every message. Such a session gets a long notice, and once it was submitted its first line scrolled off the screen AgEnD checks, so the paste could never be confirmed and the notice stayed pending. A notice whose paste reached the agent is now recorded as told. One that never reaches the agent is tried at most 3 times, then recorded with a warning in the log.
