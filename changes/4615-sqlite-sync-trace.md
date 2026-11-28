---
section: Added
---
- **Diagnostics · name the database behind an event-loop stall (opt-in).** Start the fleet with `AGEND_SQLITE_SYNC_TRACE=1` and each slow synchronous SQLite write is listed by its file name (`sqlite:<file>`) in the "Event loop stalled" log line, so a stall that waits on the disk says which database it was. Off by default, with no cost when off.
