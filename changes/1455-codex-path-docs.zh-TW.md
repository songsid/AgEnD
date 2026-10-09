---
section: Changed
---
- **Codex session resume 文件：`$CODEX_HOME` 優先於 `~/.codex`。** `docs/features.zh-TW.md` 中兩處提到 `~/.codex/state_5.sqlite` 和共用 home 的地方，現在改為 `$CODEX_HOME/state_5.sqlite`（預設值：`~/.codex`）和 `$CODEX_HOME`（預設值：`~/.codex`）。程式碼（`src/backend/codex.ts:904`）一直都是用 `process.env.CODEX_HOME?.trim() || join(homedir(), ".codex")`；文件現在與程式碼一致。
