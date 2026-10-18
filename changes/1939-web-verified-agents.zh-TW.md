---
section: Security
---
- **agent 現在會把已授權瀏覽器的訊息當成本人（#1939，第 3 步）。** fleet 管理者的 Discord 或 Telegram 帳號確認「授權這個瀏覽器」之後，那個瀏覽器的訊息會以 `[user:<名字> via web (verified), id:<使用者 id>]` 送到 agent。
  - **agent 的改變：** `web-verified` 收據的檢查與轉交（`forwards`）方式，和 Discord 或 Telegram 訊息完全一樣，本人記在 `authority.actor`。所有 agent 會讀到的地方都用同一條規則：fleet 指示、CLI 指示，以及 cross-instance-messaging 和 worker-collaboration 兩個 skill。它取代了所有「網頁不帶任何權限」的句子。
  - **仍然不帶任何權限的：** 一般的 `via web`（未授權的瀏覽器）、訪客、公開連結，以及之後被撤銷的授權（會讀成 `none`）。reviewer 的 APPROVE 是審查，不是人類的同意。
  - **標籤只是提示：** 它只隨 AgEnD 寫下的收據一起設定，agent 在以本人身分行事前，會先讀那份收據。
  - 執行中的 agent 會在更新後的下一次送達時被告知一次。
