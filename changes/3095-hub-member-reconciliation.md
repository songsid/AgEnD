---
section: Fixed
---

- AgEnD Hub (experimental, off by default): member connections now have a bounded reconnect barrier that reconciles retained delivery receipts and confirms outstanding evidence before admitting new work. Reconnection keeps completed evidence and never replays agent input. (#3095)
