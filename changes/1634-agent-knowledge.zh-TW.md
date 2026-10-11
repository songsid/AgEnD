---
section: Fixed
---
- **Agent：AgEnD 告訴 agent 的內容再次與實際行為一致（#1634）。** fleet 指示、agent CLI 參考、General 的核心規則、工具說明與十五個內建 skill 都已對照程式碼檢查。現在會說明 `reply` 的按鈕與貼圖、來自網頁聊天的訊息、實際的圖片／檔案／引用標記、遞送狀態（已接受不等於已送達；`uncertain` 不要重送）、`get_fleet_status`（只有數量；個別狀態在 `list_instances`）、`agend fleet restart` 的行為（graceful；要載入新程式碼用 `--reload`）、在 fleet session 中需要 `--yes`、各 backend 如何續接自己的 session、各 backend 分別登入、Codex 與 Muse 的回覆保護、被拒絕的 `kiro_ui: v3`，以及目前的模型列表指令。MCP server 現在回報實際的 AgEnD 版本（原本寫 0.3.0），並在指示中寫出版本，讓 agent 能判斷先前載入的工具說明是否較舊。
