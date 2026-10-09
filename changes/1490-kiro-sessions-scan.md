---
section: Fixed
---
- **Kiro session lookup no longer scans on the event loop (#1490):** while the Kiro store has no conversation for an instance yet, its transcript source falls back to Kiro's session files. On every 2-second poll it listed the sessions directory and checked every session file synchronously, which took 16–18 ms per instance with 5,000 sessions. The lookup is now asynchronous. A poll checks only the directory and recently active sessions, the directory is listed again only when it changes, and a full rescan runs every 30 seconds, at most 16 file checks at a time.
