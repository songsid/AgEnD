---
section: Added
---
- **效果隔離的基礎（#1629）：**本機 preview listener 新增獨立的 `/effect` shim，沿用既有的沙箱與網路限制。它只接受一次 HTML render 與一個私有 MessagePort，對效果只提供事件訂閱和一次 ready 訊號。這尚未啟用 dashboard 效果；公開連結的 preview 仍只提供 `/frame`。
