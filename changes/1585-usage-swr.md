---
section: Changed
---
- **The web usage panel (◔) opens at once (#1585).** When its last snapshot has expired, the panel now shows it straight away, labelled "Updated N min ago · Refreshing…", while the one refresh that expiry starts runs behind it. The fresh numbers replace it a few seconds later. Before, the panel waited for every vendor (several seconds). Vendors are called exactly as often as before. The `/usage` chat command, the `get_usage` tool and Discord presence still wait for fresh numbers. A snapshot older than 60 minutes, or one taken before a credential profile or binding changed, is never shown this way. `/api/ai-usage` is sent `Cache-Control: no-store`.
