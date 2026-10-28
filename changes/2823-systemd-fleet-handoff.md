---
section: Fixed
---
- Updates now refuse before installation when a running fleet cannot be verified as belonging to its installed systemd service. Run `agend restart` first: it can gracefully stop a proven same-home fleet outside the unit and hand it to systemd, waiting up to five minutes without force-killing it. Rollback messages distinguish a surviving recorded PID from a verified running service.
