---
section: Added
---
- **沒有接 Discord 或 Telegram 的 fleet：在網頁上核准 agent 的 Windows 請求（2.3.5-alpha.2）。** agent 要求建立 Windows agent 或修改它的設定時，這個請求現在會出現在 fleet 擁有者的「**等你處理**」裡；擁有者就是在 AgEnD 電腦上用 `agend web --code` 登入的人。以前只能在主機上執行 `agend settings confirm` 來確認。卡片會顯示誰提出的、要建立什麼（電腦、CLI、模型、資料夾、存取權限）以及何時過期。按「**核准**」只會建立一次。核准時，AgEnD 會再次確認你仍是擁有者、請求仍有效、那台電腦仍可使用。「**拒絕**」、重複點擊、過期的請求和已撤銷的登入，都會說明發生了什麼。其他人都看不到這些請求，包括其他登入、公開連結和訪客。接了 Discord 或 Telegram 的 fleet，仍由 General 的確認卡處理。
