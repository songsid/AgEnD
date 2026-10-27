---
section: Fixed
---
- **fleet 啟動時不再因 classic kiro 的大型儲存區而卡住（#2738）。** 更新到 2.3.2-beta.13 時可能被回滾：fleet 在啟動一個對話歷史很長的 classic kiro instance 時，錯過了 systemd 的 60 秒 watchdog，因而被終止。
  - **原因：** 為了確認這個 instance 的對話是否已被壓縮（#2714），fleet 在主執行緒上把 kiro 儲存區的每一份 transcript 重複讀了許多次。在一台主機上，這花了約 5 分鐘。
  - **修正：** 現在每份 transcript 只讀一次，並在背景 worker 上進行，檢查期間 fleet 會持續回應。`migrate_kiro_instance` 工具也改用同樣的方式檢查。
  - **時間限制：** 這項檢查限時 30 秒，每個工作目錄最多讀 2 GiB。若無法在限制內完成，instance 會照紀錄恢復原本的對話，並在 Log 分頁說明原因，與壓縮結果無法判斷時的處理方式相同。
