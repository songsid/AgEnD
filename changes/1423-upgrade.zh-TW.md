---
section: Upgrade Notes
---
- 敏感 Settings 的 web Apply 現在是提案，不是已完成的寫入（#1423）。本機與公開 session 都需要 General 的 fleet admin，或 host 上的 `agend settings confirm <id>`。Header-token 自動化不能授權敏感修改。請處理 `202 pending_confirmation`，遺失回應時沿用 idempotency key，等待終態結果。拒絕／到期後須重新輸入 secret。Pending 只留在記憶體，重啟後需重提。首次 Setup 須經 host 確認，再明確按 Start；沒有可確認的 chat 路徑就要求 host 確認，絕不自動套用。
