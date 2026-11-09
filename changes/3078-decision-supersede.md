---
section: Changed
---
- Superseding a decision (`post_decision` with `supersedes`) now needs the same permission as `update_decision`. Workers can still post decisions; General and coordinators can supersede them. The old decision must be active and visible to you, and if it can't be superseded, the new one isn't saved either. (#3078)
