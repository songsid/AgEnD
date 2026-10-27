---
section: Upgrade Notes
---
- **kiro instances on the classic engine: move them before kiro-cli 3.0 (#2598).** kiro-cli 3.0 drops the classic engine (`kiro_ui: legacy`, the default for an entry that sets no `kiro_ui`). AgEnD now keeps kiro from updating itself, starts new kiro instances on the TUI, and moves an existing one with its conversation through `migrate_kiro_instance` after a fleet admin confirms in General. A move is one-way. See Added, Changed and Fixed below.
