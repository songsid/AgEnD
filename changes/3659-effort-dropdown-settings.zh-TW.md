---
section: Added
---
- **設定頁「Runtime 與模型」新增推理強度下拉（#3659）。** 放在模型欄下方：選項是目前所選模型接受的強度（和聊天 chip 的 `/effort` 同一份清單），換模型時選項跟著變；第一項「模型預設」代表未設定，不會寫入。選擇時走 chip 自己的 `/effort`，所以和 chip 是同一個值，執行中的 Agent 會立即套用（部分 CLI，例如 Codex，會重啟 Agent 才生效）。Windows Agent、Antigravity，以及沒有強度設定的 CLI 或模型不顯示。模型欄有尚未儲存的變更時，這個欄位要等儲存後才能選。和 chip 一樣，不提供選回「模型預設」。
