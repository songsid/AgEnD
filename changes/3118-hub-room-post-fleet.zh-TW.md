---
section: Added
---
- 新增 `hub_room_members` 查看 Agent 所在房間的成員與狀態，`hub_people_search` 沿用擁有者可用的人員搜尋。
  Agent 可用管理員已驗證的原始指示收據代為發言；房間回答送回原 Agent 轉達，交付結果不明時保留紀錄，不重複輸入。
- 已連線且支援此功能的 Fleet，其分享 Agent 可用 `hub_room_list` 列出自己的 Hub 房間，並用 `hub_room_post`
  發文。發文沿用該 Agent 當前的房間成員資格；結果不明時保留原操作身分，避免悄悄重複發文。
