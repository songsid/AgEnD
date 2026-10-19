---
section: Fixed
---
- **又可以從網頁設定刪除 agent 了（#2168）。** 在 **設定 → Agents** 按 **刪除 agent** 再按 **套用變更**，之前不會有任何作用，頁面只顯示 `unsupported_sensitive_effect`。只要 agent 有描述、顯示名稱或自訂欄位，刪除在要求確認之前就被拒絕；聊天裡的 **刪除** 也一樣。
  - **現在：** 這項變更會等 fleet 管理者在 General 確認（或用 `agend settings confirm <id>`），確認內容寫著「<agent>: deleted」。確認後，agent 會像 `delete_instance` 一樣被停止並移除：它的排程和團隊位置也一起拿掉，不需要重新啟動 AgEnD。
  - **錯誤改成白話：** 設定無法套用某項變更時，現在會用文字說明原因，不再只顯示代碼。
