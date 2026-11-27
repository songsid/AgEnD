---
section: Fixed
---
- Removed a duplicate Hub private-file leaf stat while preserving fresh ancestor, canonical-path, permission, type, size and floor checks on every read. Synthetic fixtures use 20% fewer explicit path stats; the three main page reads show no established material CPU improvement.
