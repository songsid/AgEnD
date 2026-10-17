---
section: Security
---
- **網頁：訪客能看到哪些 agent，現在依他們在聊天中本來就能用的範圍決定，訪客 session 也有自己的期限（#1920）。目前還沒有人能以訪客登入。**
  - **哪些 agent：** 每次請求都會重新判斷。訪客能看到的，是已經允許他在那裡聊天的連線上的 agent，或他自己的 Telegram 私人房間。`open` 連線在管理者於 `web.guests.open_instances` 列出 agent 之前，不給訪客任何 agent。管理者也能用 `web.guests.narrow` 再縮小某位訪客的範圍。
  - **權限結束時：** 訪客被移出該連線的權限，或範圍被縮到沒有時，他的網頁 session 在下一次請求時就會結束。關閉 `web.guests.enabled` 會結束所有訪客 session，再打開也不會恢復。
  - **登入期限：** 預設 12 小時，閒置 2 小時（`web.guests.session`），不會長於 dashboard 或公開連結本身的期限。訪客在 session 清單裡有自己的名額，訪客登入不會把管理者登出。
