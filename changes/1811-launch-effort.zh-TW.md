---
section: Fixed
---
- **設定好的 `effort` 現在會在啟動時傳給 codex、claude-code、grok 和 antigravity（#1811）。**
  - 以前只有 kiro-cli 和 muse 啟動時會帶上它；其他 backend 只是存起來，啟動時沒有傳：在 codex 上用 `/effort` 會重新啟動 instance 卻什麼都沒變，在 claude-code、grok 和 antigravity 上則只維持到下次重新啟動。
  - 現在每次啟動（包括接續對話的啟動）都會傳入：`-c model_reasoning_effort`（codex）、`--effort`（claude-code、antigravity）、`--reasoning-effort`（grok）。
  - 存好的推理強度絕不會讓啟動失敗。只有在已安裝版本的 `--help` 列出這個參數（antigravity 1.0.x 沒有），且等級是那個 CLI 接受的時才會傳。codex 本身不檢查，所以要是模型目錄列出的等級。否則 instance 用 CLI 自己的設定啟動，並在 daemon.log 和紀錄分頁說明原因（不會發聊天通知）。
  - 已經設定 `effort` 的 instance，下次重新啟動後就會用那個等級執行。執行中的 `/effort` 不變。
