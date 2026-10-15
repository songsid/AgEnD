---
section: Fixed
---
- **Linux: a root fleet under a system unit now moves to 2.2 when it is updated from 2.1.** Hosts with `/etc/systemd/system/agend.service` installed 2.2 but kept running 2.1, because `agend restart` refused the unit's old start command. The update now points that unit's `ExecStart` at the new install, as it does for the user unit, and leaves every other line alone. (#1884)
