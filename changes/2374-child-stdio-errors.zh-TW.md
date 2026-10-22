---
section: Fixed
---
- 任何輔助程序（tmux、git、更新啟動器、用量與記憶體探測等）的 stdin、stdout 或 stderr 管道讀寫出錯時，現在只會讓那一個指令失敗，不再讓整個 fleet 當掉。fleet 的程式改為從同一個受保護的模組取得 `spawn` 與 `execFile`，若新程式直接從 Node 匯入它們，會有測試失敗（#2374）。
