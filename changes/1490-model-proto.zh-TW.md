---
section: Fixed
---
- **`/model`：拒絕含換行或控制字元的模型名稱。** 含有 `\n`、`\r` 或其他控制字元的模型名稱原本會被寫入 `fleet.yaml` 並原樣貼入 CLI session。指令現在會回傳錯誤，不寫入也不貼出。(#1490 P3a)
- **暫停/喚醒處理器：以 own-key 檢查防止繼承的原型鍵匹配 instance。** 使用者提供的 instance 名稱（如 `__proto__`、`constructor`）現在先用 `Object.hasOwn` 確認是否為自有屬性，再進行 instance 查詢，若非自有屬性則正確回傳「找不到 instance」，不會執行 `runPauseWake`。(#1490 P3b)
- **使用者 profile 處理器：在 general_topic 查詢前先執行 own-key 成員檢查。** `handleGeneralProfile` 現在在讀取 `instances[general]` 之前先確認 `Object.hasOwn`，使帶有 `general_topic` 的繼承原型項目無法冒充真實的 General——將以「僅限 General 使用」拒絕。(#1490 P3b)
