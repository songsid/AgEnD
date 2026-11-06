---
section: Added
---
- 網頁聊天的 HTML 預覽：新增「**設定 → 網頁儀表板 → HTML 預覽可從 cdnjs / jsDelivr 載入函式庫**」（`web.preview_cdn`，預設關閉）。開啟後，預覽的指令碼、樣式與字型可以來自 `cdnjs.cloudflare.com/ajax/libs/` 與 `cdn.jsdelivr.net/npm/`，其他來源一律不行。**這些請求會離開這台電腦：** CDN 會看到它們，頁面也可能藉此把資料傳出去。預覽仍然無法擷取或送出任何資料，也仍然無法使用你的登入。關閉時，若頁面的函式庫被封鎖，面板會說明。公開連結也遵循同一個設定。
