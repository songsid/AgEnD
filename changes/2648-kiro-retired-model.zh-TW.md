---
section: Fixed
---
- **對話存的是 kiro 已停用 model 的 kiro instance，不再每次啟動都回報「Model unavailable」（#2648）。** 對沒有自己 model 的 instance（instance 沒設、fleet 預設也沒設），AgEnD 現在會檢查它要接續的對話所存的 model；若 kiro 已不再提供，instance 會改用 kiro 的預設 model 接續同一個對話，並在它的 topic 說一次。若 AgEnD 事先無法判斷，第一次出現「Model unavailable」時會用預設 model 重新啟動 instance 一次。設定成使用該無法使用 model 的 instance 不會被換掉：只會提醒一次改選其他 model，不再每次啟動都提醒。
