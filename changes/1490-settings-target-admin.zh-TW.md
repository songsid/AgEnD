---
section: Security
---
- **Settings 確認依受影響 bot 的權限判定：** chat 確認需要每個既有目標連線的
  admin 資格；按鈕出現在另一個 General，不會讓該 bot 的 admin 取得確認權限。
  Fleet 層級與新增連線維持設定中 primary General 的 admin 授權；混合變更需要
  同時滿足兩者，共用 token 也包含所有使用它的連線。跨平台或目標不明時，
  在 host 執行 `agend settings confirm <id>`。網頁 pending／重試與首次 Setup
  的 host 確認流程仍可使用。 (#1490)
