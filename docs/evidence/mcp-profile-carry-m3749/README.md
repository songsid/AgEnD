# M-3749: MCP servers missing after an AI account switch

Captured from commit b14156a53 with `scripts/manual/mcp-missing-capture-m3749.mts`. It uses the smoke fixture: a scratch FleetManager running only the web server, with no fleet start, no CLI and no tmux, and a synthetic roster and profile names. The Needs-you item is the real derived item (`deriveNeedsYou` with `mcpMissing`), delivered over the dashboard's own SSE.

- `mcp-missing-desk-light-en.png`, `mcp-missing-desk-dark-zh-TW.png`: desktop, 1366×900.
- `mcp-missing-phone-light-zh-TW.png`, `mcp-missing-phone-dark-en.png`: phone, 390×844.
- `texts.json` holds, in EN and zh-TW:
  - the notice the agent receives;
  - the chat (Discord/Telegram) Needs-you line;
  - the item text each capture shows.
