---
section: Upgrade Notes
---
- **[行為變更] `/view` 不再接受網址或文字框裡的 web token。** 以前儲存個人檔案、頭像與側欄順序，可以用整個 fleet 共用的 `web.token` 以 `?token=` 送出：`/dashboard` 的「View (edit)」連結會把它放進網址列，而 `view.html` 還會把它附加到**每一個** API 請求並存進 `localStorage`。現在寫入需要已登入的 session（與其他面板相同的 CSRF 檢查），或腳本使用 `X-Agend-Token`；`?token=` 不再被當成寫入憑證，token 輸入框已移除，Edit 會把未登入的訪客帶到登入頁再回來。**預設仍可公開讀取 `/view`**（包含即時終端畫面）；新增的 `web.view_access: session` 可要求讀取也要登入。沒有任何程式接受過的唯讀 `view.token` 檔不再寫入，舊檔會在啟動時刪除。
