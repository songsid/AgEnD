---
section: Upgrade Notes
---
- **Kiro 升級恢復（#906、#1624、#1800）。** 恢復對話維持存檔時的 agent；AgEnD 不會自動輸入 /agent swap，也不會在後續啟動重試這項已暫停的切換。沒有身分或啟動紀錄的新 instance，只有在同伴目錄歸屬可確認安全時，才可能接手未認領的最新對話；衝突或歸屬不明會開新對話。對話認領會阻止其他 instance 使用同一 ID。未帶 fleet 標記的舊 steering 檔會保留並警告；請協調共用目錄的所有 fleet 後才手動移除。詳見 Kiro 升級恢復指南。
