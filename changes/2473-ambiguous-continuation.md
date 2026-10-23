---
section: Fixed
---
- Keep interrupted-work continuation identity stable across CLI respawns and fleet restarts. A continuation whose input is uncertain remains fenced instead of admitting a second prompt for the same unfinished task.
