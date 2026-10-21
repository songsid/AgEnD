---
section: Fixed
---
- **`agend fleet restart --reload` 不再讓 systemd 底下的 fleet 停擺；`agend restart` 是唯一的完整重啟（#2356）。** 原本的 reload 會讓 fleet 正常結束（`Restart=on-failure` 的 unit 視為停止），再嘗試在 CLI 自己的進程裡啟動新的 fleet。從 agent 的窗格執行時，這個進程位在 unit 的 cgroup 裡，會跟著被終止，所以什麼都沒回來（有一台主機因此停了 7 小時）；從 shell 執行時，fleet 則跑在 systemd 之外。`agend restart` 會透過實際管理 fleet 的對象重啟——systemd unit、launchd job，或 detached 交接——`agend restart <instance>` 則立即重啟單一實例。`agend fleet restart` [`--reload`] [`<instance>`] 這一版仍可用：它會印出淘汰提示並改執行 `agend restart`，2.4 會移除。在 AgEnD systemd unit 底下的 fleet 若仍收到舊的 reload 訊號（來自較舊的 CLI），現在會以讓 systemd 重新啟動它的方式結束。聊天的 `/restart` 不變。
