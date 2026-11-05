---
section: Changed
---
- `agend export` 的壓縮檔名稱除了日期也帶時間（`agend-export-YYYYMMDD-HHMMSS.tar.gz`，UTC），同一天再匯出一次會得到另一個檔案。你明確指定的路徑若已存在，仍會被拒絕。(#3088)
