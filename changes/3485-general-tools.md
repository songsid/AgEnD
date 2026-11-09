---
section: Changed
---
- General can inspect instance logs, fleet configuration, config validation and deployments, and directly set another agent’s tool profile through `update_instance_config` or `create_instance`, without a confirmation card. General cannot change its own profile through either tool; inherited object-property names are refused as targets. Other callers, including coordinators, remain refused; both tools refuse `skipPermissions` even for General. Repository leases stay outside General’s default profile. Sensitive Settings confirmations are unchanged (#3485).
