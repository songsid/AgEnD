---
section: Fixed
---
- **`agend update` no longer rolls back on a Linux host without a D-Bus user bus (#1804).**
  - On a host without `dbus-user-session`, `systemctl --user` works but `busctl --user` cannot connect. Every update there rolled back with "systemd does not know com.agend.fleet.service", even though the service was loaded and running.
  - When the bus cannot be reached, the update now checks the service with `systemctl --user` instead. It continues only if systemd has loaded AgEnD's own unit file exactly as it is on disk: no drop-ins, no reload pending, no `EnvironmentFile=` or `PassEnvironment=`. It then restarts through systemd as usual. `agend restart` runs the same check.
  - Anything that cannot be proven still rolls back. The message now gives the real reason: the manager cannot be reached, systemd does not know the unit, or the unit cannot be proven and why. The rollback line no longer claims the restored unit is not loaded when it simply could not be read.
  - Hosts with a working user bus behave as before.
