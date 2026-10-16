---
section: Fixed
---
- 修正給 agent 的投遞驗證說明：「Delivery not found」可能是 ACL 隱藏、紀錄保留期限已過，或沒有投遞。Agent 必須先取得對方明確 forward 的可驗證參照才能行動，也不能重送狀態不確定的投遞。既有 instance 升至 2.2.0 時會收到一次更正；投遞查詢與掃描器行為不變。
