---
section: Changed
---
- **Hub connection cleanup and clearer retry reasons (#3658).** Removing an online Fleet can revoke its saved Hub connection. A fresh company connection can replace that person's proved old connection in the same transaction, including at the personal Fleet limit. An unfinished pairing attempt now has a specific retry reason. Optional Hub and owner labels support the simpler connection pages while older Fleets keep their response format. Hub state uses company-join v2; downgrading requires a matching pre-upgrade backup.
