---
section: Changed
---
- AgEnD 給每個 agent 的提醒改成直接說要做什麼。投遞顯示 `uncertain` 時寫成「可能已經送達：先用 `delivery_status` 查明再確認，只有顯示 `failed` 時才重送」，agent 指令、`delivery_status` 工具、agent CLI 說明和狀態文字都一致。reply-required 與 reply-pending 提醒改成請 agent 回報做了什麼、結果如何、下一步；收到訊息時的提示改成「(Answer with the reply tool.)」。規則本身不變：重送前一定先查、只有 `failed` 才重送、回覆使用者一律走 reply 工具。
