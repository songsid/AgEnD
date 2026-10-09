---
section: Upgrade Notes
---
- Web Apply for sensitive Settings is now a proposal, not a completed write (#1423). Local and public sessions need a General fleet admin or `agend settings confirm <id>` on the host. Header-token automation cannot authorize sensitive edits. Handle `202 pending_confirmation`, retain the same idempotency key for lost-response retries, and wait for the terminal outcome. Secret fields must be re-entered after rejection/expiry. Pending requests are memory-only and must be resubmitted after restart. First-time Setup requires host confirmation and an explicit Start action; no confirmed chat route means host confirmation, never auto-apply.
