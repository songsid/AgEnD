---
section: Fixed
---
- **CLI 模式的 agent 會被告知它實際可用的指令（#1650）。** `agent_mode: cli` 的 instance 沒有 MCP 工具，但它收到的每則訊息結尾仍寫著「用 reply tool 回覆」或「用 send_to_instance／report_result」。現在這些結尾會寫出 `agend-agent` 指令：回覆使用者用 `agend-agent reply "…"`，回覆其他 instance 用 `agend-agent report <寄件者> "…" <correlation_id>` 或 `agend-agent send <寄件者> "…"`。預設 MCP 模式的 instance 看到的內容完全不變。
