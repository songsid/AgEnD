---
section: Fixed
---
- **`TmuxControlClient.waitUntilIdle`：進入初始閒置快速路徑前先檢查是否已停止或放棄。** 先前 `waitUntilIdle` 在檢查 `this.stopped || abandoned?.()` 之前就先呼叫 `this.isIdle(windowId)`，導致對已停止的控制端（或 `abandoned` 已成立時）呼叫 `waitUntilIdle` 時，只要目標視窗處於閒置或超出觀察寬限期的未映射狀態，便會錯誤解析為 `true`。此外，`Daemon.writeMessageToPane` 在原生佇列退回等待閒置時也會檢查 `waitUntilIdle` 的回傳值，當等待結果為 `false` 時不再繼續重貼文字或補送 `Enter`。(#1490)
