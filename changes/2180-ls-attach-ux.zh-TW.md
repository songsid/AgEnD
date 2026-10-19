---
section: Changed
---
- **`agend ls` 新增 `#` 列號欄，並將真實 instance name 排在最前面，可直接複製給 `agend attach` 使用。** Display name 預設隱藏以保持行寬，加上 `--display` 可在最後一欄顯示。新增篩選旗標：`--running`、`--team <name>`、`--backend <name>`。
- **`agend attach` 現在支援列號、display name 子字串與真名前綴比對。** 可傳列號（`agend attach 3` 或明確形式 `agend attach '#3'`）直接選取 `agend ls` 的第幾列；省略參數在 TTY 顯示互動選單；找不到時顯示最相近的 5 個建議，而非印出所有實例。
