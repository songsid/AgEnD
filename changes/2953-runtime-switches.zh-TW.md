---
section: Changed
---
- **Windows Runtime 改在「設定 → Runtime」開啟（#2953）。** 「使用這台電腦 Windows 上的 CLI」與「允許其他 Windows 電腦配對」取代原本設定 `AGEND_WINDOWS_CLI=1`／`AGEND_REMOTE_RUNTIME=1` 再重新啟動的做法。兩者預設關閉，儲存在 fleet.yaml（`runtimes.windows_cli`、`runtimes.remote_runtime`）。開啟時和其他存取設定一樣需要 Fleet 管理員確認；關閉會立即生效（已配對的電腦會中斷連線，但保留核准）。兩者都不需要重新啟動，也無法透過公開連結或由訪客變更。環境變數仍可覆寫設定（`1` 開啟、`0` 關閉），設定頁會標示。頁面說明這台電腦仍是 Fleet，另一台電腦只執行一個小 runner，並附連線說明：建議 Tailscale Serve，也可用 SSH 通道，不要用 Funnel，區域網路上的一般 HTTP 會被拒絕。「每台 Windows 電腦同時執行的 Agent 數」（`runtimes.max_agents_per_machine`，1–16，預設 4）設定持續執行的 Windows Agent 在每台電腦上的上限。
