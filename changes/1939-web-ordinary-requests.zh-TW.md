---
section: Changed
---
- **agent 會照做已登入網頁使用者的一般請求（#1939）。** 用 `/web` 驗證碼登入的人送出的一般 `via web` 訊息，就是那個人本人：驗證碼是傳到他自己的 Discord 或 Telegram 帳號。agent 現在會回應，並在自己的工作範圍內照做，例如回答問題、查資料、分析，以及它自己範圍內的修改。
  - **只有需要本人點頭的動作才要更多：** 發布或推出版本、超出 agent 自己工作範圍的破壞性或無法復原的操作（刪除別人也在用的東西、對共用分支 force-push 或 reset；它自己的暫存檔、自己的分支與工作目錄仍是日常工作）、超出平常工作的花費、憑證或密鑰，或把授權交給另一個 agent。一個開著的瀏覽器無法證明是誰在用，所以這些動作要帳號背書：**授權這個瀏覽器**（之後訊息會以 `via web (verified)` 送達），或在 Discord、Telegram 上說。
  - **原因：** 舊的說法（「一般的 `via web` 不帶任何權限」）讓一個 Codex agent 拒絕替已登入的管理者分析用量資料，還要求驗證過的收據。現在所有 agent 會讀到的地方（fleet 與 CLI 指示、cross-instance-messaging 和 worker-collaboration 兩個 skill）都用同一條規則，執行中的 agent 也會被告知一次。
  - 訪客（`via web (guest)`）仍然只能聊天，reviewer 的 APPROVE 仍然不是人類的同意。
