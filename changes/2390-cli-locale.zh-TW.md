---
section: Changed
---
- **CLI 現在用和 fleet 相同的方式決定語言。** 先看明確設定的 `defaults.locale`，再看主機時區（UTC+8 → zh-TW），最後才是英文。以前位於 UTC+8、沒有設定 `defaults.locale` 的主機，CLI 會顯示英文，但聊天是 zh-TW；現在 `agend settings`、重新啟動／啟動／停止、bug-report 等已翻譯的訊息都會是 zh-TW。若要維持英文，請設定 `defaults.locale: en`。會被其他程式讀取的訊息（更新程式、Windows 安裝程式與捷徑）維持英文，並有測試固定（#2390）。
