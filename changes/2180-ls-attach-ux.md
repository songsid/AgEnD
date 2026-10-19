---
section: Changed
---
- **`agend ls` now shows a `#` row-number column and the real instance name first, making the name copyable for `agend attach`.** Display names are hidden by default to keep lines short — add `--display` to show them as the last column. New filters: `--running`, `--team <name>`, `--backend <name>`.
- **`agend attach` accepts row numbers, display-name substrings, and real-name prefixes.** Passing a row number (`agend attach 3`, or the unambiguous form `agend attach '#3'`) selects that row from `agend ls`. Omitting the argument shows an interactive picker on a TTY. On no match, the closest 5 suggestions are shown instead of a full instance dump.
