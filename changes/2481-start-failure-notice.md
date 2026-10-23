---
section: Added
---
- **A fleet that keeps failing to start after an upgrade is now said plainly (#2481).** Every `agend` command and `agend doctor` show that the installed version is not starting, with the exact command to go back to the previous version (the last one that ran, or the copy an updater kept, whose path is shown) and where the error is (`fleet.log`). macOS also posts one notification. Nothing is rolled back automatically. A slow start, a fresh install that is still starting, or a fleet you stopped are never reported.
