---
section: Added
---
- **Web 聊天：預覽 agent 的 HTML（#1306）。** agent 回覆裡的 ` ```html ` 區塊下方會出現一張卡片：**預覽** 會在一個由另一個本機 listener（`web.preview_port`，預設 `health_port + 1`）提供的沙箱框架裡執行 HTML，因此它無法使用 dashboard 的登入，也無法操作 dashboard；**停止** 會關閉它；**下載** 會存成 `reply.html`。每台裝置的預覽**預設都是關閉的，要那台裝置自己允許**（在側欄或卡片選單），而且每次都要按下才會執行，並附上說明：預覽可能把資料傳出去，也可能讓分頁變慢或卡住。只有 fleet 標記為 agent 的回覆才會有卡片——來自人的 HTML 一律只顯示成程式碼。透過 tunnel 或 proxy 時需要 `web.preview_origin`（另一個主機名稱），否則卡片會說明預覽為什麼關閉。
