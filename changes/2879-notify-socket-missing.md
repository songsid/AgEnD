---
section: Fixed
---
- When systemd's notify socket is gone (a user unit whose `/run/user/<uid>` was removed or replaced, so systemd restarts the fleet every 15 minutes), the fleet's log now says so and how to fix it (restart `user@<uid>.service` from a host shell — it restarts the fleet too — and turn linger on if it is off; `sudo` for a user who is not root), and `agend doctor` shows a **Notify socket** row.
