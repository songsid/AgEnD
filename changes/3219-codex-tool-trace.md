---
section: Changed
---
- Codex's tool trace in the chat now reads like Claude's: **Running a command: npm**, **Editing a file: <path>**, **Viewing an image: <path>**, MCP tools as **server · tool**, and a web search as **Searching the web**, instead of a plug icon and the raw tool name on every line. A command's waits for output fold into the command, and plan updates are no longer lines of their own. At the verbose level a command's line also shows the command itself, trimmed and with secrets redacted. The tool trace's words now follow the fleet's language (English or Traditional Chinese).
