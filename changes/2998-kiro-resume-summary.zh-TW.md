---
section: Fixed
---
- **kiro 聊天室重開時，不再把「請簡短總結目前對話」貼到頻道（#2998）。** kiro-cli-chat 在恢復非空對話時會自動插入這句提示；AgEnD 從不使用那份摘要，閒置的 ClassicBot 房間每次重啟都會花 token 回覆它。現在恢復啟動會帶一個不呼叫模型的 INPUT 蓋掉這句提示。全新啟動不變。
