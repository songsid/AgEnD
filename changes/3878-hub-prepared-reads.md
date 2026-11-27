---
section: Fixed
---
- Hub pages reuse prepared read statements on the same database connection instead of preparing them thousands of times. Every read still executes and checks current access; no results are cached.
