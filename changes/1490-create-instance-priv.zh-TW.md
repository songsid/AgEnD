---
section: Fixed
---
- **`create_instance`：`tool_set` 和 `skipPermissions` 現在會以權限邊界錯誤拒絕。** 被誘導的 General 可以用 `create_instance` 建立有 `full` 設定檔、免確認的 worker。這兩個欄位現在在 Zod 的 `passthrough()` 把它們轉送給 instance-lifecycle 之前就被拒絕。錯誤訊息與 #804/#814 已有的 `update_instance_config` 拒絕訊息一致。(#1490 P3 #13)
- **`update_instance_config`：`saveFleetConfig` 拋出例外時，記憶體中的 patch 現在會被還原。** 先前，instance config 會先在記憶體中修改再儲存。若儲存失敗，記憶體和磁碟的狀態會不一致。處理器現在會在儲存失敗時還原記憶體狀態。(#1490 P3 #48)
