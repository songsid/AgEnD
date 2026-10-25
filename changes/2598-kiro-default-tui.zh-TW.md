---
section: Changed
---
- **新的 kiro instance 會從 kiro 的 TUI 引擎開始（#2598）。** kiro-cli 3.0 拿掉了經典引擎，所以現在建立的 kiro instance 會用 `kiro_ui: tui`，`create_instance` 也會把它寫進 fleet.yaml。既有的 instance 不會被搬動：沒有設定 `kiro_ui`、但已經用經典引擎啟動過的 instance 會留在原處，因為直接切換會讓它從空的對話開始；要搬請用 `migrate_kiro_instance`，它會帶著歷史過去。ClassicBot 的 kiro 頻道目前也維持經典引擎。fleet.yaml 裡設定的 `kiro_ui`（個別 instance 或 defaults）仍然優先。
