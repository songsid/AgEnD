---
section: Fixed
---
- **主機上的每個 Claude 登入都會出現在用量裡，包括額度用完、已經沒在用的那個（#2236）。** 以前所有 agent 都改用具名 Claude profile 之後，預設登入（往往正是剛用完額度的帳號）就會從 `/usage`、`get_usage` 與 dashboard 消失；agent 全部停止的 profile 也一樣。現在每個登入都有一列：「Claude (default)」與每個 profile。額度用完的會顯示 100% 與重置時間，或顯示用量查詢被限流。沒有 agent 使用且尚未登入的 profile 仍會隱藏。
