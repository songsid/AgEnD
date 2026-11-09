---
section: Changed
---
- General 可檢視 instance 紀錄、fleet 設定、設定驗證與部署，並透過 `update_instance_config` 或 `create_instance` 直接設定其他 agent 的工具組，不需確認卡片。其他呼叫者（含 coordinator）仍會被拒絕；這兩個工具對 General 也拒絕 `skipPermissions`。預設 General 工具組仍不含儲存庫租約工具，敏感設定的確認流程不變。
