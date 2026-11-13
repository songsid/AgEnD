---
section: Changed
---
- **Agent delivery tools return compact receipts and acknowledgements by default.** Status keeps proof, authority, origin and hashes with a redacted excerpt; request `detail: true` for complete original verification evidence. `contains` checks an authorised message's exact text without echoing the query. Send acknowledgements keep delivery IDs and warnings; broadcast keeps per-recipient IDs and failures. Full-detail compatibility and delivery/authority checks are preserved.
