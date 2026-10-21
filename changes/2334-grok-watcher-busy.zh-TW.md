---
section: Fixed
---
- **Grok：Watchers 面板動畫不再讓 instance 卡在「busy」狀態（#2334）。** Grok Build 的 Watchers 面板會使用點字旋轉符號和計時器，導致舊版 busy pattern 在真正的對話回合結束後仍繼續命中。現在改為要求 Grok 所有真實對話狀態列上都有的 `[stop]` 取消按鈕（`Waiting for response`、`Compacting`、`Run Read …` 等）——Watchers 面板沒有 `[stop]`，因此會被正確忽略。
