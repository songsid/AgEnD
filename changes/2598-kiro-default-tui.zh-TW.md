---
section: Changed
---
- **新的 kiro instance 會用 kiro 的 TUI 引擎（#2598）。** kiro-cli 3.0 拿掉了經典引擎，所以現在每一種建立 kiro instance 的方式都會在 fleet.yaml 寫入 `kiro_ui: tui`：`create_instance`、網頁精靈、`agend setup` 或 `agend quickstart` 建立的新 fleet，以及 fleet 自動建立的 General 或 topic。既有的 instance 不會被搬動：沒有設定 `kiro_ui` 的項目照舊是經典引擎。要搬請用 `migrate_kiro_instance`，它會帶著歷史過去。fleet defaults 裡的 `kiro_ui` 仍然決定繼承它的 instance。
