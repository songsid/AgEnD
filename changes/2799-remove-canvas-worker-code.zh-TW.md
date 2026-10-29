---
section: Changed
---
- **Canvas Worker 特效的程式碼已刪除（#2799）。** #2793 之後已沒有任何方式能開啟它；這次把程式碼本身移除，連同每秒檢查一次 `fleet.yaml` 開關的輪詢。頁面與 agent 都看不出差別：已存的 `web.experimental.canvas_worker` 照常載入、也留在 `fleet.yaml` 裡，呼叫已移除的工具會得到同樣的回答，已存的特效、套用位置與 mod 都原封不動留在磁碟上，降版後仍找得到。
