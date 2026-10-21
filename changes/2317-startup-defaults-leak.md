---
section: Fixed
---
- **SIGHUP no longer restarts all instances when only `defaults.startup` changes (#2317).** `defaults.startup.stagger_delay_ms` and `defaults.startup.concurrency` were being merged into every instance's config, so any change to either field appeared as a cold-field change in every running instance and triggered a fleet-wide restart. These fields are now correctly treated as fleet-level controls and not propagated to instance configs.
