---
section: Fixed
---
- **A ClassicBot room whose restart fails after a Settings save comes back up (M-2966).** When a room's settings were saved, for example its AI account, and the room then failed to start with them, the change was rolled back but the room was left stopped. The rollback now starts it again with what it had before. A room that was stopped meanwhile, or started again by something else, is left as it is. The restart and the rollback are now one owned operation (as for `update_instance_config` in #3715), so a Stop sent during the save is no longer followed by a launch.
