---
section: Added
---
- The usage report (Fleet → Usage, `get_usage_report`, the CSV) now measures Muse: each model call's tokens from its sessions, a subagent's under its parent session's agent, with reasoning. Muse's cache writes read "not reported" (always 0 so far), and its amount is "not priced" (Meta publishes no per-token price).
