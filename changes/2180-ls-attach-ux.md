---
section: Changed
---
- **`agend ls` now shows a `#` row-number column and the real instance name first (#2169, #2180).** Display names are hidden by default to keep lines short — add `--display` to show them as the last column. This amends the #1809 behaviour where display names were mixed into the Name column. New filters: `--running`, `--team <name>`, `--backend <name>`.
- **`agend attach` accepts row numbers, display-name substrings, real-name prefixes, and the unambiguous `'#N'` row token (#2169, #2180).** `attach` still resolves display names (enter `agend attach 鑄碼副手` to find by display name); the name is simply no longer shown in `ls` by default. On no match, the closest 5 suggestions are shown instead of a full instance dump.
