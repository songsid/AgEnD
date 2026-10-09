---
section: Added
---
- **網頁：只用網頁的 fleet 會顯示首次使用卡片，設定精靈也能接上既有的 agent（#1549）。** 沒有任何 Telegram 或 Discord 連線時，聊天頁和設定 › Agent／連線會顯示一張卡片：**連接聊天應用程式** 會開啟設定精靈，**只用網頁** 會在這個瀏覽器裡隱藏卡片。設定精靈的第一步可以選 **既有的 agent** 或 **新的 agent**。既有的 agent 會保留它的目錄、backend 和設定，只有聊天連線改成新的機器人。新的 agent 也不能再沿用既有 agent 的名稱，把它覆蓋掉。完全沒有 agent 時，聊天頁會提供 **新增 instance**，側欄的新增 instance 按鈕也改成 **+**。開發者分頁的下載按鈕改為 **下載 fleet.yaml**，新增 instance 對話框裡的「Topic 名稱」欄位改為 **名稱**。
