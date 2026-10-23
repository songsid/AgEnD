---
section: Changed
---
- **Global search no longer drops entries after 90 days by default (#2516).** Unset `web.search.retention_days` means no age limit; the daily prune still caps the index at 300,000 rows (oldest first). Set a positive integer (1–3650) to age-prune, or `0` for the same no-age-limit default. Settings → Web shows the current value read-only.
