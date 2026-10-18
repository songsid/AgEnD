---
section: Added
---
- **網頁 session 會記錄帳號的授權（#1939，第一步：目前只記錄）。** 從網頁送出的訊息、指令或按鈕點擊，現在會在送達收據中說明由誰授權：
  - **`web-session`：** 已登入的 fleet 管理者本人帳號，透過直接連線的 dashboard，且在登入後 48 小時內。收據會記下該 session 的裝置代號，以及瀏覽器是在這台電腦還是網路上。
  - **`none`：** 其他所有網頁來源：公開連結、訪客、`agend web` 的登入、較舊的 session。
  - **`platform`：** Discord 與 Telegram 的訊息，和以前一樣。
  - `delivery_status` 會回傳它，事件紀錄也會記下每一則 `web-session` 訊息。目前還沒有任何東西依它行動：agent 仍只把網頁訊息當成辨識。
  - `web.verified_authority.loopback_only` 與 `max_session_hours` 決定誰符合資格。
