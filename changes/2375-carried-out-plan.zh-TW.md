---
section: Fixed
---
- **macOS 上，更新之後的每一次 `agend restart` 不再重複「launchd already runs the job an interrupted update planned」（#2375）。** 更新會留下一份 launchd 計畫。當 launchd 已經在執行計畫中的 job，這份計畫就沒有要啟用的東西了：`agend restart` 現在會直接重啟這個 job，不再顯示這段提示。計畫紀錄會保留到下一次更新時被取代，每次更新都是如此。
