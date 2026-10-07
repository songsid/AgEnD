---
section: Added
---
- **Web 聊天：Markdown、多行輸入、重新整理不再清空。** 儀表板聊天的訊息現在會渲染 Markdown（粗體、斜體、`code`、程式碼區塊、清單、引用、連結——只接受 http/https/mailto、在新分頁開啟），
  而訊息內容無法產生任何自己的標記（先跳脫整段文字再套格式）。輸入框可多行（Enter 送出、Shift+Enter 換行），送出失敗會把文字還給你。重新整理不再清空聊天：fleet 會保留每個 instance 最近的訊息
  （`GET /ui/history`，存在記憶體、有上限），SSE 斷線重連時會補送漏掉的訊息。Agent 的長回覆在 web 聊天中不再於 2,000 字截斷（現在 16,000）。
