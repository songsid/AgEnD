---
section: Fixed
---
- **設定：每條連線顯示自己的狀態（#1537）。** 過去只要 AgEnD 在執行，每條連線都顯示「已連線」，即使它沒有啟動或 token 被拒。現在每一列顯示該連線自己的狀態：已連線 · @your_bot、重新連線中、啟動中、未執行、缺少 token、token 被拒，或開啟 Message Content Intent 的指示。
