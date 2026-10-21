---
section: Fixed
---
- **macOS 上，更新之後的每一次 `agend restart` 不再重複「launchd already runs the job an interrupted update planned」（#2375）。** 更新會留下一份 launchd 計畫；當 launchd 已經在執行計畫中的 job，這份計畫就已完成，現在會被移除，而不是在之後每次重啟時再判斷一次（並提示一次）。
