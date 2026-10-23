---
section: Fixed
---
- macOS 上的 `agend stop` 現在會等 launchd 真的卸載 fleet 的工作後才結束（#2505）。以前 fleet 還在關閉時就顯示「Service stopped.」，緊接著執行 `agend start` 會失敗：「Bootstrap failed: 5: Input/output error」。如果 30 秒後 launchd 仍保有該工作，`agend stop` 會說明並以 1 結束。
