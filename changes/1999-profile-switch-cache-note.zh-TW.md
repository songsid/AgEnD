---
section: Changed
---
- 把 Claude Code instance 切換到另一個憑證 profile 時，不再斷言快取一定是空的。回覆中的 `conversation_note`、文件與 credential-profiles skill 現在會說明：切換本身不會讓提示快取變空；在同一個快取範圍內（組織；供應商隔離工作區時還包括工作區），模型與提示前綴不變時通常會沿用快取；快取範圍、模型或 profile 設定不同，或快取已過期時，下一輪可能要以完整價格重建快取。
