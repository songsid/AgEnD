---
section: Security
---
- **Dashboard 不再從 Google 載入字型，每個面板都帶 `Content-Security-Policy`**，把 script、樣式、圖片、字型與連線都限制在本站（`connect-src 'self'`），即使頁面上真的跑了不該跑的 script，也無法把讀到的內容送到別的伺服器。
