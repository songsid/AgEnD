---
section: Added
---
- **升級後 fleet 起不來時，現在也會在聊天裡說（#2490）。** `agend` 指令和 `agend doctor` 顯示的那則訊息（#2481），會貼一次到 General，沒有 General 時改私訊第一位管理員。訊息寫明版本、怎麼退回、錯誤訊息在哪裡，給只從 Discord 或 Telegram 使用 AgEnD 的人。它在該版本第三次啟動失敗時，由那次失敗的啟動本身透過平台的 API 送出。每個版本只貼一次，crash loop 期間不會重複，盡力而為。
