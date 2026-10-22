---
section: Fixed
---
- 任務看板：派工者是已刪除的 fleet instance 的卡片（卡在它的問題上，或在待確認等它確認）現在會轉給你（「等你處理」，需設定 `needs_you.task_board: true`，以及每日摘要）：已經沒有其他人能回覆或確認它。ClassicBot 身分不算已刪除的 instance；卡片本身不會被修改（#2425 後續）。
