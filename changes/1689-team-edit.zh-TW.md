---
section: Added
---
- **網頁：可以編輯 team（#1689）。** 「Fleet → Teams」的每個 team 現在都有 **編輯**，會打開已填好目前成員和描述的 team 表單；已不在 fleet 裡的成員仍會列出，方便移除。儲存時使用與 agent 的 `update_team` 工具相同的更新：成員必須是這個 fleet 的 instance，只要有一個不是就不會儲存。team 無法重新命名，表單上會說明（請建立新的 team 再刪除舊的）。組織圖下次打開時就會反映變更。`update_team` 現在也可以修改 team 的描述（留空即清除）。`agend-agent team-update <名稱> [新增,…] [移除,…] [描述]` 現在可以正常使用了：它原本把成員清單當成純文字送出，會被 `update_team` 拒絕。儲存失敗時，team 會維持原狀。`update_team` 和 `create_team` 現在只接受 fleet.yaml 確實定義的名稱，`constructor` 或 `__proto__` 不再會被當成 instance 或 team。
