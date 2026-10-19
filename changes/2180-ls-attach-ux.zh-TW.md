---
section: Changed
---
- **`agend ls` 新增 `#` 列號欄，並將真實 instance name 排在最前面（#2169, #2180）。** Display name 預設隱藏以保持行寬，加上 `--display` 可在最後一欄顯示。此為 #1809 行為的修正版：display name 不再混入 Name 欄。新增篩選旗標：`--running`、`--team <name>`、`--backend <name>`。
- **`agend attach` 現在支援列號、display name 子字串、真名前綴與明確的 `'#N'` 列號形式（#2169, #2180）。** attach 依然可以透過 display name 查詢（例如 `agend attach 鑄碼副手`），只是 ls 預設不顯示 display name。找不到時顯示最相近的 5 個建議，而非印出所有實例。
