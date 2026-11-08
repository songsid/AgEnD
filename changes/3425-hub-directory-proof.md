---
section: Changed
---
- **Hub AD settings gain internal preparation guards (#3425).** The shared writer can be preceded by current-directory reauthentication, immutable candidate identity/group checks and one bound trust confirmation. Public setup and AD editing remain unexposed until composition is complete.
