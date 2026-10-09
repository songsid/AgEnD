---
section: Fixed
---
- **Quickstart「新增允許使用者」：支援 `channels:` 陣列形狀的設定檔。** 抽取為可匯出的 `addAllowedUsersToConfig()`。有多個連線時，提示會顯示連線的 `id` 和 `group_id` 以便區分，且不會在檔案中寫入幽靈 `channel:` 鍵。(#1490 P2)
- **Quickstart「覆寫（重新開始）」：備份改為 fail-closed。** 抽取為可匯出的非同步函式 `backupFleetConfig()`（失敗時拋出例外）。若備份無法寫入，覆蓋動作會中止並印出錯誤——使用者不會在以為有備份的情況下遺失唯一的設定。(#1490 P2)
