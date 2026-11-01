---
section: Added
---
- **只用網頁的 fleet：坐在 AgEnD 電腦前的人就是管理者（#2910）。**沒有 Discord 或 Telegram 連線的 fleet 上，用 `agend web --code` 登入、並在那台電腦上使用的瀏覽器，會立即以「**這台電腦的管理者**」通過驗證：
  - 它的訊息以 `via web (verified)` 送到 agent；回執的 `authority.actor` 是 adapter `host`、user `operator`。
  - 它自己按 **套用** 就能確認自己的設定變更（例如 **新增 agent**），不再需要 `agend settings confirm`。
  - 從別台機器或透過公開連結都不行；透過聊天送出的登入碼不算這台電腦的；撤銷授權後，請再用 `agend web --code` 登入。
  - 有聊天連線的 fleet 不受影響。
