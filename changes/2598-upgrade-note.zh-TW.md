---
section: Upgrade Notes
---
- **用經典引擎的 kiro instance：請在 kiro-cli 3.0 之前搬到 TUI（#2598）。** kiro-cli 3.0 拿掉經典引擎（`kiro_ui: legacy`，也是沒設定 `kiro_ui` 的項目的預設）。AgEnD 現在不讓 kiro 自行更新，新的 kiro instance 用 TUI 啟動；既有的 instance 可透過 `migrate_kiro_instance`，經 fleet admin 在 General 確認後連同對話一起搬過去。搬移是單向的。詳見下方的新增、變更與修正。
