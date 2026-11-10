---
section: Fixed
---
- Files/Changes and Follow now share conservative, case-insensitive filename exclusions, including `.envLOCAL`, custom `id_` keys and names containing credential or secret. Matching directories also protect their descendants; hidden files expose neither contents, diffs nor line counts. (#3153, #3160)
