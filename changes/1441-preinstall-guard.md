---
section: Added
---
- **Preinstall guard (#1441 Part A): npm aborts and rolls back on incompatible Node.** A `preinstall` lifecycle script now exits 1 when the running Node does not support N-API 10 (`^22.14.0 || ^23.6.0 || >=24`). This protects machines running the OLD 2.1.x updater: instead of installing a new version that would crash at the first DB open, npm rolls back and keeps the existing version intact. `--ignore-scripts` bypasses the guard; see Upgrade Notes.
