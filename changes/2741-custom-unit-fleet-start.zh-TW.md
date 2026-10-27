---
section: Fixed
---
- **由自己的 systemd unit 執行的第二個 fleet 又能啟動了（#2741）。** 自 #2356 起，由自訂名稱的 unit 執行的 `agend fleet start`（例如有自己 `AGEND_HOME`、`Type=notify` 的第二個 fleet）會被交給主機上主要的 AgEnD 服務，然後以 0 結束；systemd 因此記錄 `Result=protocol`，並不斷重新啟動該 unit。現在只有執行這個程序的 AgEnD home 的服務（unit 或 plist 的 `AGEND_HOME`，沒寫則為預設 home）才會接手啟動或停止；任何名稱、`Type=notify` 的 unit 都算服務管理器自己的啟動。若在 `NOTIFY_SOCKET` 下仍然交出，會說明並建議使用 `agend fleet start --direct`。
