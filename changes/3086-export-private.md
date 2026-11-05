---
section: Fixed
---
- `agend export` now writes its archive readable only by you (mode 0600) from the moment it is created, for both full and minimal exports. If the output path already exists (a file, a link or a folder), the export stops and leaves it alone instead of overwriting it. A failed export no longer leaves a partial archive. (#3086)
