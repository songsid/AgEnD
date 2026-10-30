---
section: Fixed
---
- When systemd's notify socket is gone (a user unit whose `/run/user/<uid>` was removed or replaced, so systemd restarts the fleet every 15 minutes), the fleet's log now says so and how to fix it (restart `user@<uid>.service`; turn linger on too if it is off), and `agend doctor` shows a **Notify socket** row.
