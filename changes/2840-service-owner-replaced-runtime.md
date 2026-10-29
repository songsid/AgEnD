---
section: Fixed
---
- Updating a systemd fleet from 2.3.3-beta.1 no longer stops with "fleet ownership could not be verified" and rolls back. The check now recognises a fleet whose bundled Node runtime the update has just replaced.
