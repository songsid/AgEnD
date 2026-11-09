---
section: Changed
---
- **General 的 `general` 工具權限組合現已包含所有編排工具（#3043）。** 作為 AgEnD 的管理員（車隊決策 `9e3bea6c`），General 除原有的 `create_instance`、`start_instance`、`restart_instance`、`wake_instance`、`get_web_settings` 與 `set_web_settings` 外，現在也能直接呼叫完整的編排工具集（`delete_instance`、`replace_instance`、`stop_instance`、`pause_instance`、`deploy_template`、`teardown_deployment`、`create_team`、`delete_team`、`update_team`、`update_instance_config`、`update_fleet_defaults`、`migrate_kiro_instance`、`reconcile_kiro_instance` 與 `update_decision`）。獨立於工具清單外的權限邊界維持不變：`create_instance` 與 `update_instance_config` 仍拒絕變更 `tool_set` 與 `skipPermissions`（#804/#814），而敏感的設定變更（權杖、存取控制與管理員名單）仍須經車隊管理員確認。
