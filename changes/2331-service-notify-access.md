---
section: Fixed
---
- **Linux: a fleet service no longer restarts every 15 minutes because systemd refuses its ready signal (#2331).** The
  fleet says it is ready through a `systemd-notify` helper, which systemd accepts only with `NotifyAccess=all`. A unit
  that loaded `main`, `exec` or nothing (an early 2.0 beta's unit, a hand-written system unit, a leftover drop-in) kept
  the fleet in `activating`; since the start timeout became 15 minutes, systemd killed and restarted it every 15
  minutes. `agend restart` and updates now put `NotifyAccess=all` into the unit, ask systemd what it loaded, add
  AgEnD's own drop-in when another drop-in overrides it, and name leftover service files. `agend doctor` shows the
  unit as loaded (the system unit when one runs the fleet) and the files it came from; an update no longer writes an
  unused user unit beside a system unit. Updating to this release repairs it in the same update. See
  [cli](cli.md#service-management).
