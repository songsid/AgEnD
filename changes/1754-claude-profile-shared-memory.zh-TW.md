---
section: Fixed
---
- **使用 Claude credential profile 的 instance 保有共用的自動記憶（#1754）。** 具名 profile 有自己的 `projects/`，所以 Claude Code 對該 repository 的記憶在那裡原本是空的，和其他 instance 的記憶分開。現在每次以 profile 啟動時，都會把 profile 裡該 instance 所在 repository 的記憶資料夾連到 `~/.claude`（或你自己設定的 `CLAUDE_CONFIG_DIR`）底下的共用記憶。對應的 key 是 repository 根目錄，git worktree 以主 checkout 為準，和 Claude 自己決定記憶位置的方式一致。對話仍然各 profile 分開。profile 裡已經有筆記的記憶資料夾絕不會被取代：會保持原樣並記錄警告。沒有使用 profile 的 instance 啟動方式完全不變。
