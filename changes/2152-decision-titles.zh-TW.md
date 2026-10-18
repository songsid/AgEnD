---
section: Changed
---
- **`list_decisions` 預設只回傳標題（#2152）。** 列出 id、標題、範圍、日期與 tags；`list_decisions { id }` 取得某一條的全文，`{ full: true }` 取得全部。fleet 的完整清單已超過 100 KB（一次約 3 到 4 萬 token，而每次重啟都會讀一次）。fleet 指令改成先讀標題，再取需要的那幾條。CLI 模式：`agend-agent decision-get <id>`。`agend-agent decision-list true` 重新會包含已封存的決策（這個旗標先前被用另一個名稱讀取）。
