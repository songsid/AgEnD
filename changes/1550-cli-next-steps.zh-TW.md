---
section: Changed
---
- **CLI：設定完成後指向網頁儀表板（#1550）。** `agend quickstart`、`agend setup` 和 `agend init` 結束時會顯示儀表板的網址（`http://localhost:19280/`，或 fleet 設定的 `health_port`），並說明登入方式：執行 `agend web --code`，或傳 `/dashboard` 給你的 bot。quickstart 的步驟改為 1/4 到 4/4。`agend init` 安裝系統服務時現在會一併啟動它；以前它建議的 `systemctl` 服務名稱並不存在。「安裝 Discord plugin」那一行也拿掉了，因為 Discord 已經內建。`npm install` 成功時，最後一行會是「Next: run `agend quickstart`」。README 和網站的快速開始頁面也更正了 Node 版本需求，並加上儀表板的說明。
