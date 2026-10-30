---
section: Fixed
---
- systemd 的通知 socket 不見時（使用者 unit 的 `/run/user/<uid>` 在沒有 linger 時被移除，systemd 因此每 15 分鐘重啟 fleet），fleet 的紀錄現在會說明原因與修正方式（`loginctl enable-linger`，再重啟 `user@<uid>.service`），`agend doctor` 也多一列**通知 socket**。
