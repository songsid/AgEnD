---
section: Fixed
---
- kiro 啟動時若回報已存 session id 有多個相符項目，現在會保留原本的 session，不再因反覆失敗而丟棄它、改開新對話。這能保護從 classic 帶過來、在 kiro 2.34 兩個 store 都出現相同 UUID 的對話；重複紀錄仍須另行復原（#2598）。
