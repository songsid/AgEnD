---
section: Fixed
---
- **Starting an agent and signing in from the dashboard no longer stall the fleet on a synchronous `which` (#1490).** Spawn, the browser backend list, and dashboard `/login` now use the existing async PATH probe. A missing CLI still only logs on spawn, and dashboard login still refuses with the install command; a probe that times out still counts as not installed.
