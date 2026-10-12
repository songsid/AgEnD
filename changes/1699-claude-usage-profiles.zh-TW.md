---
section: Added
---
- **每個 Claude Code profile 各自的用量（#1699 第 3 部分）。** 使用中的每個 Claude Code credential profile 現在在 `/usage`、`get_usage` 以及 dashboard 的用量側欄與對話框中都有自己的一列（`Claude (work)`、`claude:work`），與預設的 `Claude` 列並列。每一列只讀該 profile 自己的登入（macOS 上是 claude 為該 profile 目錄保存的鑰匙圈項目），不會讀預設登入。用量 API 無法回應時，該列只會改用自己 instance 寫下的額度。尚未登入的 profile 會顯示「尚未登入」、`/login claude-code <profile>`（#1699 第 2 部分）與在主機上登入用的完整指令，不會顯示其他帳號的數字。在此之前，使用 Claude profile 的 instance 完全沒有用量列。沒有 Claude profile 的 fleet 與以前完全相同。
