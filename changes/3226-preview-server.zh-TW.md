---
section: Added
---
- **Hub（實驗功能，alpha）：隔離的 HTML 預覽伺服器。** 已初始化的 Hub 可設定 `hub.web.preview_port`，以獨立的 HTTPS 連接埠提供既有的 Fleet 預覽沙箱，並共用 Hub 的瀏覽器憑證與更新。未設定時關閉。HTML 仍須通過房間的登入與檔案權限檢查；預覽伺服器只提供空白啟動頁，不讀取或設定 Cookie。Hub 的預覽側欄會在後續更新加入。詳見[設定與安全邊界](docs/design/hub-preview.md)。
