---
section: Fixed
---
- **Kiro transcript reads recover from one stuck worker:** after a read times
  out, its worker loses read ownership and a replacement can resume from the
  source's accepted cursor without restarting the fleet. Late replies and exit
  events cannot affect the replacement. A retired worker still occupies a
  physical slot until it exits; at most two workers can exist. If both native
  calls remain stuck, reads retain their 15-second deadline and legacy fallback
  until one exits. Kiro's shared database remains read-only. (#1490)
