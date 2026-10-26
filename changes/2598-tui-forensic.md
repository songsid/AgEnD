---
section: Fixed
---
- Forensic peer-envelope scans now read an owned, pinned kiro TUI session, including conversations carried from classic, instead of its frozen SQLite copy. Legacy scans keep using SQLite; V3 and incomplete or unowned TUI history remain explicitly unreadable. This does not open raw Log history (#2598).
