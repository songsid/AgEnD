---
section: Fixed
---
- **Starting an agent and signing in from the dashboard no longer stall the fleet on a synchronous `which` (#1490).** Spawn, the browser backend list, and dashboard `/login` now use the existing async PATH probe. Spawn also pins that off-loop path so constructing the backend cannot fall back to a synchronous lookup. A Stop during the outer spawn probe still owns the outcome: the old start does not publish skills or start a daemon. A missing CLI still only logs on spawn, and dashboard login still refuses with the install command; a probe that times out still counts as not installed.
