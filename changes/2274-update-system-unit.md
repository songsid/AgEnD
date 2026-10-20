---
section: Fixed
---
- **`/update` from the chat works again when the fleet runs as the system-wide service `/etc/systemd/system/agend.service` (the 2.1-era layout for root, as on WSL) (#2274).** It used to stop at "preparation" with "Failed to connect to bus", because the updater always asked the user's systemd for its own scope. A fleet under the system service now gets its updater scope from the system's systemd.
