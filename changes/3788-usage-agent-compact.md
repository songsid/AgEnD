---
section: Changed
---
- **Agent usage tools return compact account rows by default.** `get_usage` and `agend-agent usage` keep quota/reset, account and stale hints without repeated localization or capacity blocks; `detail: true` (`--detail`) returns full JSON. `get_usage_report` shares its API-equivalent basis once and includes speed only with detail. The web usage panel and `/usage` retain their existing display.
