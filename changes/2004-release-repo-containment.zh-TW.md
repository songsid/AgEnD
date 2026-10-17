---
section: Fixed
---
- **`checkout_repo` 恢復可用（#2004），`release_repo` 只會移除該 instance 自己的 checkout。** 自四月的參數強化修改之後，`checkout_repo` 對任何分支都會失敗（「Needed a single revision」）。`release_repo` 現在會先解析路徑，只有在它是該 instance 自己 `repos/` 目錄內的 git worktree 時才移除；其他路徑一律拒絕，也不會被動到。
