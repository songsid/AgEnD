---
section: Changed
---
- **Config validator now warns when `startup` is set inside an instance entry (#2322).** `startup.concurrency` and `startup.stagger_delay_ms` are fleet-level controls that belong under `defaults.startup`; they have no effect under `instances.X.startup`. Move the key to `defaults.startup` or remove it.
