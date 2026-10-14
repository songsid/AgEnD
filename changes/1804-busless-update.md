---
section: Fixed
---
- **`agend update` no longer rolls back on a Linux host without a D-Bus user bus (#1804).**
  - On a host without `dbus-user-session`, `systemctl --user` works but `busctl --user` cannot connect. Every update there rolled back with "systemd does not know com.agend.fleet.service", even though the service was loaded and running.
  - When the bus cannot be reached, the update now asks systemd over its private socket instead: the same connection `systemctl --user` uses on such a host. It reads exactly the same definition it reads over the bus, so it checks exactly the same things before it restarts through systemd. `agend restart` does the same.
  - Anything that still cannot be proven rolls back. The message now gives the real reason: systemd cannot be reached at all, systemd does not know the unit, systemd refused the request, or the unit does not start the new install. The rollback line no longer claims the restored unit is not loaded when it simply could not be read.
  - Hosts with a working user bus behave as before.
  - **One manual step on such a host.** The update to this version is still checked by the version that is running, so from 2.2.0-beta.9 or earlier it rolls back once more. Install this version yourself with `npm i -g @songsid/agend@beta`, then run `agend restart`; the restart uses the new check. Updates after that run normally.
