---
section: Fixed
---
- **Office 權限不再阻擋降版至 2.3.1 或 2.2.6（#2578）。** 設定頁改用 `defaults.office_access`、`instances.<name>.office_access`，不再把新功能寫入舊版嚴格驗證的 dashboard 清單。既有 `dashboard.office` 會保留備份後轉換。Office 仍預設關閉，開啟確認及工具限制不變；降版 CI 驗證兩個已發布版本對開啟、關閉設定都可接受。
