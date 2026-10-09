---
section: Fixed
---
- **Kiro transcript 能從單一 worker 卡住後恢復：** 讀取逾時後撤掉舊 worker 的
  讀取權，由替代 worker 沿用來源已接受的游標，不必重啟 fleet。舊回覆與 exit
  事件不會影響替代 worker。舊 worker 在真正退出前仍佔用實體名額，最多兩個；
  若兩個 native call 都卡住，讀取維持 15 秒期限與 legacy fallback，等其中
  一個退出才恢復。Kiro 共用資料庫仍只讀取。 (#1490)
