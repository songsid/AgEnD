---
section: Fixed
---
- When a newer version's private tmux server survives a raw downgrade, foreground fleet start now prints the refusal and exits with status 1 after cleanup, instead of reporting an unhandled error and hanging. The downgrade guard and service retries remain in place (#3437).
