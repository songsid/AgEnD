---
section: Fixed
---
- When systemd's notify socket is gone (a user unit whose `/run/user/<uid>` was removed without linger, so systemd restarts the fleet every 15 minutes), the fleet's log now says so and how to fix it (`loginctl enable-linger`, then restart `user@<uid>.service`), and `agend doctor` shows a **Notify socket** row.
