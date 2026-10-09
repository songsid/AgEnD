---
section: Fixed
---
- **`TmuxControlClient`：觀察時間改用單調時鐘。** `observationResetAt`、`inObservationGrace`、`lastOutputAt` 和 `isIdle` 現在全部使用 `this.mono()`（由 `performance.now` 支撐）而非 `Date.now()`。時鐘跳動（NTP、日光節約時間）不再導致 pane 在靜默視窗到期前就被視為閒置，也不再讓 grace 期比預期長。(#1490 P3)
- **`TmuxControlClient.waitUntilIdle`：用戶端停止時改為解析 `false`。** 原本解析 `true`，等於告訴呼叫端 pane 已閒置，可能觸發對已停止用戶端的投遞。(#1490 P3)
