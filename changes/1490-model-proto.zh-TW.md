---
section: Fixed
---
- **`/model`：拒絕含換行或控制字元的模型名稱。** 含有 `\n`、`\r` 或其他控制字元的模型名稱原本會被寫入 `fleet.yaml` 並原樣貼入 CLI session。指令現在會回傳錯誤，不寫入也不貼出。(#1490 P3a)
- **使用者輸入的 instance 查詢現在改用 `Object.hasOwn`。** 暫停/喚醒和使用者 profile 處理器中有兩處以 plain object 查詢 instance 表，會把 `__proto__`、`constructor` 這類原型鍵當成有效的 instance 名稱。改用 `Object.hasOwn` 後，繼承自原型的鍵會正確回應「找不到 instance」。(#1490 P3b)
