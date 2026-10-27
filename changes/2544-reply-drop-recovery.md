---
section: Fixed
---
- **Reply-drop recovery no longer flags a Codex reply that already reached the person, or a scheduled turn that was not meant to answer anyone (#2544).** A `reply` that the adapter confirmed before Codex wrote `task_complete` (or before paste proof armed the guard) now counts for that turn. Schedules, silent schedules, cross-instance updates and system notices skip the person-reply guard — at most a debug line, no channel warning. What is still reported, and where, is in #2566's entry.
