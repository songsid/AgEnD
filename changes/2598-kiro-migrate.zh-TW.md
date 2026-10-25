---
section: Added
---
- **kiro：把 instance 從經典引擎搬到 TUI，並保留它的對話（#2598）。** kiro-cli 3.0 拿掉了多數 kiro instance 在用的經典引擎（`kiro_ui: legacy`）。以前手動改 `kiro_ui`，instance 會在空的 TUI 對話上啟動，也不會告訴你。新的 `migrate_kiro_instance` 工具一次搬一個 instance：它的經典對話會在 TUI 下接續一次（kiro 會把整段歷史複製過去），並登記為它自己的對話；執行中的 instance 會重啟。要等 fleet admin 在 General 按下「搬過去」確認才會進行，結果會貼在 General 和該 instance 的 topic。
- **kiro：搬過去的 instance 不會再用經典引擎啟動（#2598）。** 退回去會接回凍結的經典副本，失去在 TUI 上做的一切。AgEnD 會拒絕這種啟動並說明原因。`kiro_engine_status` 會顯示每個 instance 的 `engine_floor`。這也包括在這個版本之前曾以 TUI 執行、後來又改回 `kiro_ui: legacy` 的 instance：要把 `kiro_ui` 改回 `tui` 它才會啟動。
- **kiro：TUI 啟動不再使用 kiro 的單純 `--resume`（#2598）。** AgEnD 無法選定 TUI instance 自己的對話時（較舊的 kiro-cli），會開新對話並說明。kiro 的單純 `--resume` 可能接到別的 instance 的對話，或把經典對話分岔出一份。經典引擎的啟動不變。
