---
section: Fixed
---
- systemd 的通知 socket 不見時（使用者 unit 的 `/run/user/<uid>` 被移除或換掉，systemd 因此每 15 分鐘重啟 fleet），fleet 的紀錄現在會說明原因與修正方式（重啟 `user@<uid>.service`；linger 沒開的話也一併開啟），`agend doctor` 也多一列**通知 socket**。
