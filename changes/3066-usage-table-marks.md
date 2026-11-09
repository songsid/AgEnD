---
section: Changed
---
- **The per-agent usage table is quieter.** Fleet → Usage no longer puts a pill under a row for every note. Only what changes how a number is read stays, as a small mark with its reason in a tooltip, and a key under the table names only the marks that appear:
  - **◐** partly priced, **†** the amount as the CLI reported it, **≈** estimated (Kiro).
  - A missing number is "—", and its tooltip says why ("Not priced: …", "Codex/Muse don't report cache writes", "Not reported by this CLI").
  - Hours read before AgEnD recorded their backend and profile get one note under the table instead of a pill on each row.
  - The Reasoning and Messages columns are left out when they would be "—" in every row.
  - Codex hours whose credential profile was not recorded say "profile not recorded".
  - The basis line is shorter; the subscription note moved into its tooltip.

  The CSV and `get_usage_report` keep every flag unchanged. (#3066)
