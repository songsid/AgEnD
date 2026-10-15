---
section: Added
---
- **Agent 可以看到自己在網頁上的樣子（#1629）。** `get_web_appearance` 回傳 agent 的頭像與來源、外框顏色、身分卡的每個欄位、淺色／深色模式的主題、鎖定狀態與限制，解析方式與儀表板完全相同。`preview_web_appearance` 會把這些畫成每個模式一張 SVG，寫到 agent 工作目錄的 `.agend/appearance/`，用到的圖片另存在旁邊（只有它自己的）。也可以用 `agend-agent appearance [preview [light|dark]]`。
