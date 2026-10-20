---
section: Fixed
---
- Recover Codex turns that stop after exhausting HTTP429 retries with up to three delayed conditional continuations, then pause and notify. Preserve the original context, ignore resumed error history, and keep quota exhaustion separate from transient limits.
