---
section: Added
---
- The usage report (Fleet → Usage, `get_usage_report`, the CSV) now measures OpenCode: each finished assistant message's tokens from its database (input, cache reads and writes, output and reasoning), by its session's directory, each message once across OpenCode's two message tables. A model the price table lacks takes the cost the provider charged when there is one, marked "amount as the CLI reported it", else "not priced".
