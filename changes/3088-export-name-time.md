---
section: Changed
---
- `agend export` names its archive with the time as well as the date (`agend-export-YYYYMMDD-HHMMSS.tar.gz`, UTC), so a second export on the same day gets its own file. A path you give explicitly is still refused if it already exists. (#3088)
