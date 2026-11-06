---
section: Changed
---
- **只用網頁的 fleet，入口都以網頁為先（#2910）。**
  - 沒有 Discord 或 Telegram 連線的 fleet，登入頁會寫「在 AgEnD 電腦上執行 `agend web --code` 取得登入碼。」；登入碼錯誤時也用同樣方式說明怎麼取新碼。「沒有聊天 bot？」的說明會隱藏，因為沒有 /web 可以傳。
  - 在這種 fleet 上，`agend quickstart`、`agend setup` 和 `agend init` 結束時只顯示這一種登入方式。
  - README、快速開始指南和 `install.sh` 都說明 quickstart 預設只用網頁，bot token 是選用的。
  - 有聊天連線的 fleet 不受影響。
