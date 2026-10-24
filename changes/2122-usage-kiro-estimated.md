---
section: Added
---
- The usage report (Fleet → Usage, `get_usage_report`, the CSV) now covers Kiro. Kiro records no token counts, so each turn is **estimated** from its text size the way tokscale does, from all three of Kiro's stores (classic, TUI and V3), and priced at the named model's list price (`auto` is not priced). Every Kiro row says "estimated", the totals say they include estimates and how much of the amount is estimated, and the CSV has an `estimated` column. The scan runs on a worker thread and never writes to Kiro's stores.
