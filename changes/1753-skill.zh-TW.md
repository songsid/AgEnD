---
section: Changed
---
- **Skill：credential-profiles 已更新，涵蓋 Claude Code profile 用量列與手動複製對話的做法（#1753）。** skill 現在反映 Claude Code profile 各自有 `Claude (<profile>)` 用量列（自 #1713 起）；過時的「尚未有獨立列」說明已改為正確行為，包括從未登入的 profile 顯示的「Not logged in」列。新增兩個段落，說明自動化上線（#1753、#1754）前的手動做法：「切換時保留 Claude 對話」（停止 → 複製 `.jsonl` 與 checkpoint 資料夾 → touch → 啟動 → 驗證）和「共用記憶體」（將空的 `memory` 目錄以 symlink 指向預設 profile 的副本）。
