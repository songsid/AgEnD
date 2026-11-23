---
section: Changed
---
- Agent 每次開始對話時讀的指示少了約 1,000 個 token（CLI 模式約 1,200）：每條規則只寫一次，「Active Decisions」只列標題（需要時 Agent 才讀規則全文），網頁聊天的收據檢查細節移到 cross-instance-messaging skill，Agent 在需要確認的動作之前會讀它。規則本身不變（#4347）。
