---
section: Fixed
---
- A Hub restored from a backup no longer holds every connected Fleet when the Hub's authorization version had gone up after the backup, for example from the upgrade's roles migration. The Fleet reports the version it has seen; once the Hub has checked the Fleet's credential, the Hub raises its own version to match, only upward and with an audit entry. The Fleet then reconnects with its shares and grants.
