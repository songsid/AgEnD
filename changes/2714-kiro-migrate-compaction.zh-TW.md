---
section: Fixed
---
- **kiro：把 classic instance 搬到 TUI 時，現在會帶走 `/compact` 之後的對話（#2714 後續；由 hxhsandy 回報）。** classic kiro 壓縮對話後會用新的 id 繼續。壓縮後還沒重啟過的 instance，之前搬移時會把壓縮前的那份帶進 TUI。
  - `migrate_kiro_instance` 現在會沿著 classic 重啟時走的同一條、經過證明的壓縮鏈，帶走最新的對話，確認提示也會說明這一點。
  - 若壓縮鏈無法證明，搬移會被拒絕，什麼都不改：讀不到儲存區、有兩個延續的對話，或延續的對話屬於其他 instance。搬移是單向的，若帶走舊的 id，較新的內容就會被丟下。
