---
section: Changed
---
- **AgEnD reads `~/.agend/.env` the same way everywhere (#1545).** At start, when a new connection starts without a restart, and when a new token's variable name is chosen, the same rules apply: `export KEY=value` lines, quoted values, and the last of a repeated key. A token is therefore never read one way at start and another way later.
