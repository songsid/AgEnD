---
section: Fixed
---
- **中止同一 session 的 OOM 重生迴圈（#2035）。** Linux kernel 連續兩次確認同一 instance／session 的 CLI 因 OOM 死亡後，改以可用的交接快照開啟新 session，並保留舊對話與 session ID。若恢復程序仍因 OOM 死亡，就停止重試並通知 instance 與 General。死因不明與 macOS 維持原本的重啟策略。
