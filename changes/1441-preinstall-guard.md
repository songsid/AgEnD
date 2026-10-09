---
section: Added
---
- **Preinstall guard (#1441 Part A): npm aborts on incompatible Node.** A `preinstall` lifecycle script now exits 1 when the running Node does not support N-API 10 (`^22.14.0 || ^23.6.0 || >=24`). A **direct** `npm install -g @songsid/agend` on Node 20 fails before any files are changed, leaving the existing version intact. Note: the 2.1.x updater path calls `npm unlink` before installing; if the unlink already ran, preinstall failure means no version is left — see the Upgrade Notes. `--ignore-scripts` bypasses the preinstall hook but the CLI's own bootstrap guard exits 1 on the first run, so the OLD updater's `agend --version` verification step still aborts the restart.
