---
section: Changed
---
- 網頁登入：私下傳給你的 /web 登入碼（私訊、Discord 只有你看得到的回覆，或你與 bot 的 Telegram 私訊）現在會讓那個瀏覽器在登入當下就完成驗證，不用再按一次卡片確認。你的私訊會收到「已登入」通知與「不是我」按鈕，按下會登出那個瀏覽器。不是私下傳送的登入碼、訪客登入碼，以及在有聊天連線的 fleet 上用 `agend web --code`，都和以前一樣。授權到期後，仍是按卡片延續，或用 /web 重新登入。
- 透過你的固定網域（named link）取得網頁授權，現在和臨時公開連結一樣預設開啟；設定 `web.verified_authority.named_link: false` 可關閉。
