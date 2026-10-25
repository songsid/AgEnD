---
section: Changed
---
- **New kiro instances run on kiro's TUI engine (#2598).** kiro-cli 3.0 drops the classic engine, so every way of creating a kiro instance now writes `kiro_ui: tui` into fleet.yaml: `create_instance`, the web wizard, a new fleet from `agend setup` or `agend quickstart`, and a General or topic the fleet creates by itself. Existing instances do not move: an entry that sets no `kiro_ui` stays classic, as before. Move one with `migrate_kiro_instance`, which carries its history. A `kiro_ui` in the fleet defaults still decides for the instances that inherit it.
