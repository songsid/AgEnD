---
section: Changed
---
- **General 不再收到每日提示，也不再收到「2.2 新增網頁聊天」訊息（#2783）。** AgEnD 每天在 General 發的提示移除了，設定 → Agent 預設值的 **每日提示** 以及 `/tips on`／`/tips off` 也一併移除。`/tips` 仍可隨時抽一則提示，`/tips advanced on` 也保留。`fleet.yaml` 裡已有的 `defaults.tips` 照常載入、不會有警告，也會留在檔案裡，降版後仍保有你的選擇。連新安裝也會收到的那則一次性網頁聊天介紹也移除了。
