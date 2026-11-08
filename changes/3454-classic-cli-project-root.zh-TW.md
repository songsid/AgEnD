---
section: Fixed
---
- **ClassicBot Agent 的專案決策只留在自己的房間（#3454）。** 透過 Agent 端點（CLI 模式，`agend-agent decision-*`）發布的 ClassicBot 專案決策，以前會存在一個空的專案下，所有 CLI 模式的 ClassicBot 房間都共用它。現在它們屬於該 Agent 自己的工作區，和透過 MCP 工具時一樣。既不是 Fleet 執行個體、也不是 ClassicBot Agent 的呼叫者會被拒絕。Fleet 執行個體的行為不變。
