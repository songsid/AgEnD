---
section: Changed
---
- **Skill：credential-profiles 已更新，涵蓋 Claude Code profile 用量列（#1753）。** 過時的「Claude Code profile 尚未有獨立用量列」說明已改為正確行為：每個具名的 Claude Code profile 現在都有自己的 `Claude (<profile>)` 列，從該 profile 自己的登入讀取配額；從未登入的 profile 顯示「Not logged in — run `/login claude-code <profile>` to sign in」。「已登出」提醒列現在明確說明僅適用於 Kiro。
