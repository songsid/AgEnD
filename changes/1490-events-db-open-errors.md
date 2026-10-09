---
section: Fixed
---
- **A history file that is only locked or unreadable is no longer thrown away (#1490):** when `events.db` could not be opened, the fleet renamed it to `events.db.corrupt-<time>` and started an empty one, whatever the reason. Now only a file SQLite proves is not a usable database (`SQLITE_NOTADB`, `SQLITE_CORRUPT`) is moved aside. A lock that lasts past the 5-second busy timeout, a SQLite driver that does not load on this Node.js (built for another version or architecture), or a permission or disk problem leaves the file exactly as it is: the fleet runs without event logging until it restarts, and posts the reason (with `npm rebuild better-sqlite3` for the driver case) to the General topic.
