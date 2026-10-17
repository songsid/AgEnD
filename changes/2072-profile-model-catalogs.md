---
section: Changed
---
- **`/model` lists the models of the account an instance actually uses (#2072).** A Claude credential profile now has its own model catalog, read with that profile's own login, so `/model`, its "More models…" and the check of a typed model show what that account can use, not the default login's list. The model an instance runs is always among `/model`'s choices: one its CLI does not list is shown first, marked "not in this CLI's list". (Codex and Kiro profiles keep one catalog per backend: their model lists are read from the CLI's shared files, not from the profile's own account.)
