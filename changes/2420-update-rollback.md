---
section: Fixed
---
- **An update whose new service does not come up rolls back again (#2420).** Since 2.3's installer (#2264), a failed restart left the fleet stopped on the new version, with its new unit, and a second `agend update` did nothing. Now the previous package (with its bundled Node), its systemd unit (user or system) or launchd plist, and the previous service come back, and the update says so and exits 1 — as 2.2's updater did. On macOS the new fleet must actually come up under launchd (it does not wait for it, and restarts a fleet that exits at start forever) before an update counts as done. The rollback copy needs about 235 MB free on the npm prefix's disk; without it the update refuses before changing anything, and says so. A successful update is unchanged.
