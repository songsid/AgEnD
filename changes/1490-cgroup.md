---
section: Fixed
---
- Chat updates from a Linux service run in an independent same-user systemd scope, so stopping the fleet does not kill its updater (#1490). Unknown cgroup state or an unavailable scope launcher refuses with host-shell recovery instructions. Installed-path verification, environment, working directory and the two-second delay are preserved; no credentials are placed in argv.
