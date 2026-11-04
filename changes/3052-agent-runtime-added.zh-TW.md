---
section: Added
---
- 已配對 Runtime 會回報套件版本、程式碼 Build ID、支援協定與功能，電腦資訊會顯示回報內容並明確說明舊版未提供資訊；可用 `agend-runtime --version` 在本機查詢，無須連線。
- 連接電腦流程下載的 Runtime 會包含確認過的 AgEnD 位址與可雙擊的 `connect-agend.bat`。新電腦仍以互動方式配對，既有配對會直接重連，且不會將憑證送往另一台主機。
- 現有 Agent 可從 Runtime 與 CLI 設定，切換至 Fleet 主機、Windows 本機或已配對的 Windows 電腦，保留 Agent 身分、訊息路由與 AgEnD 聊天歷史。切換後先暫停，啟動時使用新的 CLI 對話；原有檔案與供應商對話保留在原電腦。
