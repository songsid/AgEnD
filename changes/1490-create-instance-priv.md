---
section: Fixed
---
- **`create_instance`: `tool_set` and `skipPermissions` refused with a privilege-boundary error.** A steered General could use `create_instance` to spawn a `full`-profile, no-confirmation worker. Both fields are now refused before Zod's `passthrough()` can forward them to instance-lifecycle. The error message matches the existing `update_instance_config` refusal from #804/#814. (#1490 P3 #13)
- **`update_instance_config`: in-memory patch is rolled back when `saveFleetConfig` throws.** Previously, the instance config was mutated in memory before saving. A failed save left memory and disk inconsistent. The handler now rolls back the in-memory state on save failure. (#1490 P3 #48)
