---
section: Changed
---
- **網頁設定裡的每個 backend 與模型欄位都改成清單（#2072）。**
  - **Backend 欄位：** 每個 backend 欄位（agent、fleet 預設值、ClassicBot、舊版 fleet 設定表單）都會列出所有 backend，並註明這台主機的狀態；無法使用的會顯示為停用並說明原因，目前使用中的一律可選。
  - **模型欄位：** 每個模型欄位（agent 的模型與備援模型、fleet 預設、ClassicBot 房間、新增 agent）會列出該 backend 對該 agent 帳號的模型（取自快取清單）。目前使用中的模型一定會列出，若不在 CLI 清單裡會加註；選「其他…」可以填入 CLI 沒列出的名稱。
