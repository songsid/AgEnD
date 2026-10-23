---
section: Fixed
---
- **Keep a session-OOM stop across restarts (#2473, stage 2).** A session stopped after repeated confirmed CLI OOMs now stays stopped through fleet restarts, automatic retries and incoming work. An explicit per-instance Start, Restart or Wake retries it while preserving the session and transcript. Damaged stop evidence stays held, and storage failures name the recovery limit. This does not change existing turn-resume behavior or add automatic continuation.
