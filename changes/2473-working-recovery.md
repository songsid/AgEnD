---
section: Added
---
- **Continue interrupted task work after a stable restart (#2473, stage 3).** Eligible unfinished tasks receive one pressure-paced inspection prompt after startup stabilizes. Unknown background inventory is explicitly advisory; known running background work and unknown session ownership still hold recovery. A per-instance `resume_interrupted_work` opt-out leaves the journal enabled. Possible input is durably fenced to prevent duplicate continuation; existing interrupted-turn and reply-reminder paths keep their current behavior in this stage.
