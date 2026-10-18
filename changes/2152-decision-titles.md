---
section: Changed
---
- **`list_decisions` answers titles by default (#2152).** It lists id, title, scope, date and tags; `list_decisions { id }` gives one decision's full text and `{ full: true }` all of it. The fleet's full list had grown past 100 KB (≈31k–42k tokens in one call, read after every restart). The fleet instructions now say to read the titles, then fetch what is needed. CLI mode: `agend-agent decision-get <id>`. `agend-agent decision-list true` includes archived decisions again (the flag was read under another name).
