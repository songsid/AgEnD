---
section: Added
---
- **Usage per agent, for agents and the dashboard's coming page (#2122, part 1).** `get_usage_report` gives each instance's (or each backend's, model's, credential profile's or team's) input, output, cache read and cache write tokens, requests and delivered messages over today, 7 days, this month, all or custom days in the fleet's timezone. It also gives each one's **API-equivalent at list price — not money spent**, the same price table and check date as the cache report.
  - **Measured:** Claude Code and Codex. Codex records no cache writes, so they say "not reported" and are never priced as uncached. An unpriced model shows its tokens without an amount. Kiro and the other backends are listed with their reason, never as $0.
  - **History:** usage is collected from fleet start and kept for 400 days in a daily rollup beside each instance's ledger. Folding is crash-safe: an hour is counted once. Delivered messages are counted when a receipt first becomes delivered.
  - **The public link:** the report is served there only with `web.usage_report_on_public_link: true`. Guests never get it.
