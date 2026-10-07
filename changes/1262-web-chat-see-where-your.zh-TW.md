---
section: Added
---
- **Web 聊天：看得到訊息送到哪一步、看得到 agent 正在處理，也能中止它。** 從 web 聊天送出的每則訊息都有送達勾，和 Telegram 訊息上的表情回應是同一套流程：◷ 排在前一則之後、✓ 已交給 agent、✓✓ agent 已收到、! 未送達（每個都有給螢幕閱讀器的標籤，重新整理後仍保留）。目前開著的聊天，其 agent 正在處理時，輸入框上方會顯示「*名稱* 處理中…」與 **中止** 按鈕，作用和 Telegram 的取消按鈕與 `/cancel` 相同：對 CLI 送 Esc，並取消還在排隊的訊息——它們的勾會變成 ⊘。（中止是 `POST /ui/cancel/<instance>`，和 dashboard 其他寫入一樣需要 session 與 CSRF 檢查；它不是 instance 的 Stop，後者會結束整個程序。）Web 訊息的送達回報也不再拿一個從來不是 Telegram 訊息的 id 去 Telegram 上加表情。
