---
section: Fixed
---
- **Reply-drop recovery no longer flags a Codex reply that already reached the person, or a scheduled turn that was not meant to answer anyone (#2544).** A `reply` that the adapter confirmed before Codex wrote `task_complete` (or before paste proof armed the guard) now counts for that turn. Schedules, silent schedules, cross-instance updates and system notices skip the person-reply guard — at most a debug line, no channel warning. The remaining notice says it may be a false positive, shows what was detected, never recommends `/clear`, and offers asking the agent to continue or resending; it is rate-limited per instance (English and zh-TW).
