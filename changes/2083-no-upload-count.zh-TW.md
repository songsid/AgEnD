---
section: Changed
---
- **Agent 的外觀上傳不再計算次數（#2083）。** Agent 可以依需要上傳主題圖片、效果（Canvas Worker 效果仍是 2.3 beta）與提案的 mod，以前是每小時最多 3 次。
  - **仍然適用：** 每張圖片的大小與尺寸限制、agent 的圖片配額、效果與 mod 本身的大小上限、變更至少相隔 30 秒且每小時最多 10 次、小工具資料的限制、`web.themes.agent_edit`，以及人的鎖定。
  - **`get_web_theme`：** 它的 `limits` 不再列出剩餘的上傳次數。
