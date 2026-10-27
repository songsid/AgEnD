---
section: Fixed
---
- **A second fleet run by its own systemd unit starts again (#2741).** Since #2356, `agend fleet start` run by a custom-named unit (for example a second fleet with its own `AGEND_HOME`, `Type=notify`) was handed to the host's main AgEnD service and exited 0. systemd then logged `Result=protocol` and restarted the unit forever. Now a start or stop is handed over only to a service that runs this process's AgEnD home (the unit's or plist's `AGEND_HOME`, else the default home). A unit of any name with `Type=notify` counts as the service manager's own start. If a hand-over still happens under `NOTIFY_SOCKET`, it says so and suggests `agend fleet start --direct`.
