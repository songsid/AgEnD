---
section: Fixed
---
- **A rollback that cannot put the previous version back no longer leaves AgEnD uninstalled (#1490).** When an update failed and the rollback moved the new package aside but then could not move the saved previous package into place, the install path was left empty, so the `agend` command no longer worked. Now the package that rollback moved aside is moved back (only when the install path is still empty), so the new version stays installed, and the message says so.
