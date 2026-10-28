---
section: Changed
---
- 代理之間的訊息少了固定文字。不需回覆時，下方那行「If you need to reply…」拿掉了；需要回覆時，原本獨立的「A reply IS required…」那行改成標頭行末尾的短標記：`reply required → report_result <correlation id>`（CLI 模式則是 `agend-agent report` 指令）。標頭不再顯示 `request_kind`，Fleet 流量與 log 仍會記錄。來自人的訊息不變。
