---
section: Fixed
---
- **Recover after a network outage (#2191).** Discord gateway rebuilds contain retiring WebSocket handshake errors. Failed connections keep retrying and offer **Settings → Connections → Retry now**. Fleet-internal tools work without a chat adapter, and suppressed MCP recovery is reconsidered after its cooldown. Fatal fleet errors record their reason before shutdown.
