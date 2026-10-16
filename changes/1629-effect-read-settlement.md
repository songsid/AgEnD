---
section: Fixed
---
- Keep effect reads reserved until their body cancellation finishes, and recheck freshness after cleanup. Prepare host-only settled reads for the shared app runtime without changing request scopes or starting new playback.
