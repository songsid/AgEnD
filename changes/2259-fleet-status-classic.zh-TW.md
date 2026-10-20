---
section: Fixed
---
- **`get_fleet_status` 現在會把 ClassicBot 頻道計入總數，與 `agend ls` 一致（#2259）。** 這個工具過去只計算 fleet.yaml 的實例，現在會一併加入 ClassicBot 頻道。回傳值也新增 `fleet:` 與 `classic:` 細項，讓呼叫端能分別查看各群組的執行/暫停/停止數量。兩個 ClassicBot 頻道若共用相同 instanceName，僅計算一次，與 `agend ls` 的去重邏輯相同。
