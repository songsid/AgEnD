---
section: Fixed
---
- **網頁聊天：emoji 不再顯示成方框（#1630）。** dashboard 使用的每一種字型，包括各 agent 主題的字型，最後都會接上系統的彩色 emoji 字型（Segoe UI Emoji、Apple Color Emoji、Noto Color Emoji）。
  - 圖片無法載入的 Discord 伺服器表情會顯示為 `:名稱:`，不再是空白方框。dashboard 不認得的也會顯示為 `:名稱:`，不會出現原始的 `<:名稱:id>`。頁面仍然不會從 Discord 載入任何東西。
