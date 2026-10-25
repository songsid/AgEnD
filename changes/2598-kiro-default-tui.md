---
section: Changed
---
- **New kiro instances start on kiro's TUI engine (#2598).** kiro-cli 3.0 drops the classic engine, so a kiro instance created now runs `kiro_ui: tui`, and `create_instance` writes that into fleet.yaml. Existing instances do not move. An instance without `kiro_ui` that has already launched on classic stays there, because switching it would start an empty conversation; move it with `migrate_kiro_instance`, which carries its history. ClassicBot kiro channels also stay on classic for now. A `kiro_ui` set in fleet.yaml, per instance or in the defaults, still wins.
