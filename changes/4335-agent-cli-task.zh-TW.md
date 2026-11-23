---
section: Added
---
- **`agend-agent task` 能做 `task` 工具能做的所有事。** CLI 模式（`agent_mode: cli`）的 agent 以前不能關注卡片、開子任務或專案裡的卡、也不能建專案。現在指令列有 `watch`、`unwatch`、`create-project` 和 `move-project`；`create` 可帶 `--project`、`--parent`、`--scope`、`--acceptance`、`--context`、`--needs-review`、`--size`、`--dispatcher` 和 `--depends-on`；`list` 可用 `--project`、`--parent`、`--stale`、`--detail`、`--limit` 和 `--cursor`；`update` 和 `move` 接受工具有的所有欄位（`--check`、`--uncheck`、`--state`、`--log`、`--comment`、`--version` 等）。Fleet 用和工具呼叫同一套規則判斷（誰能編輯卡片、過期的 `version`、一次只做一張、工具組），原本有固定位置的參數照舊。
