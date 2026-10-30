---
section: Fixed
---
- systemd 的通知 socket 不見時（使用者 unit 的 `/run/user/<uid>` 被移除或換掉，systemd 因此每 15 分鐘重啟 fleet），fleet 的紀錄現在會說明原因與修正方式（在主機的 shell 重啟 `user@<uid>.service`，fleet 也會一併重啟；linger 沒開的話也一併開啟；非 root 使用者需加 `sudo`），`agend doctor` 也多一列**通知 socket**。
