---
section: Added
---
- **網頁：身分卡（#1629）。** 每個 agent 都可以有肖像、橫幅、標語與簡介，顯示在詳細資料最上方、View 中，以及摺疊在聊天裡。
  - Agent 用 `set_web_theme`（`card.*`）與 `set_web_theme_asset`（`portrait`、`banner`）設定自己的；人在 View 的 **編輯個人資料** 設定自己的，人設定的欄位逐欄優先。**清除卡片** 移除人的；**重設主題…** 移除 agent 的。
  - 每張卡片都有 **小／中／大**；**設定 → 網頁外觀** 設定你所有裝置上每張卡片的大小。
  - 上傳限制在 `fleet.yaml` 的 `web.appearance` 或 **設定 → 網頁外觀**（預設：肖像 1024×1536／1.5 MiB、橫幅 1600×600／768 KiB、每個 agent 8 張／4 MiB），並有硬性上下限。調高需 fleet admin 確認，限制變更時已存的圖片不會被刪除。
  - 超過一則訊息大小的圖片會分段上傳，agent 的工具與 `agend-agent theme asset` 都是如此。
