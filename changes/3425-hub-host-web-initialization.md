---
section: Added
---
- Add host-session-only Hub setup APIs that reuse the sealed CLI initializer, keep credentials write-only, recheck directory identity and listener availability at Save, and transfer setup events into the Hub audit chain before listeners open. The browser form follows separately. Hub names are optional in CLI and web setup. Older builds refuse the new Hub audit schema; see [state rollback guidance](docs/design/hub-host-web-initialization.md#required-audit-and-recovery).
