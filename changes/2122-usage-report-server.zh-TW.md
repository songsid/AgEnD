---
section: Added
---
- **每個 agent 的用量，給 agent 與即將推出的 dashboard 頁面（#2122，第一部分）。** `get_usage_report` 依 instance（或依 backend、模型、憑證 profile、team）列出今天、7 天、本月、全部或自訂期間（依 fleet 的時區）的 input、output、cache read、cache write token、請求數與已送達訊息數，以及**依牌價換算的 API 等值——不是實際花費**；價格表與查證日期和快取報告相同。
  - **可量測的：** Claude Code 與 Codex。Codex 不記錄 cache write，所以顯示「未回報」，也絕不會被當成未快取來計價。沒有定價的模型只顯示 token，不顯示金額。Kiro 與其他 backend 會列出原因，絕不顯示成 $0。
  - **歷史：** fleet 一啟動就開始收集，每日彙總存在各 instance 的 ledger 旁邊，保留 400 天。併入的過程不怕中斷，每一小時只計一次。每一小時都記下讀取它的 backend 與憑證 profile，所以換掉 instance 的 backend 或 profile，或改用 AgEnD 無法量測的 backend，都不會改寫或藏起它先前量到的資料（這個版本之前的小時會顯示為「未知」）。已送達的訊息則在 receipt 第一次變成 delivered 時計數。讀不到的 transcript 或目錄絕不會被當成「已涵蓋、用量為 0」。
  - **公開連結：** 只有設了 `web.usage_report_on_public_link: true` 才會透過公開連結提供，送出前會再檢查一次這個設定與登入狀態；訪客一律拿不到。
