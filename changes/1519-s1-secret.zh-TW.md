---
section: Security
---
- **Settings 密鑰端點：公開連結（gateway）session 一律回傳 403。** 六個負責寫入或驗證連線 token/密鑰的端點（`/secrets/:id/verify`、`/secrets/:id/apply`、`/connections/:id/secret/verify`、`/connections/:id/secret/apply`、`/connections/:id/binding/verify`、`/connections/:id/binding/apply`），以及接收原始 bot token 的 quickstart probe 端點，現在在公開連結 session（`surface: "gateway"`）呼叫時回傳 403。本機 dashboard session 不受影響。(#1519)
- **文件：`create_instance` 和 `update_instance_config` 的權限邊界分開描述。** `tool_set` 和 `skipPermissions` 只能透過 Settings 或 `fleet.yaml` 設定。`update_instance_config` 明確拒絕 `tool_set`；`skipPermissions` 不是接受的欄位（Zod 會剝除它）。`create_instance` 明確拒絕這兩個欄位。(#1519)
