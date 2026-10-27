---
section: Fixed
---
- **A new Codex instance on a fresh install starts quietly (#2743).** On a machine where Codex had never run, the first Codex instance warned "Codex session database unreadable (SQLITE_CANTOPEN)" and started with `codex resume --last`. Codex had not created its session database yet, so there was nothing to resume. A missing database now means a new conversation, with no warning. A database that exists but can't be read is handled as before. So is a missing one when this directory already has Codex conversation history, or when AgEnD can't read the Codex folders to check.
