---
section: Changed
---
- **Hub directory changes gain an internal browser-session handoff (#3425).** Recent AD authentication is separate from cookie activity; the existing directory decision can expire old sessions and create one request-local admin successor atomically. Public AD editing remains unexposed. The required schema makes older binaries refuse this state; use a pre-upgrade backup for rollback.
