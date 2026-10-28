---
section: Fixed
---
- Updates and restarts refuse when the running fleet is outside its installed systemd service or ownership cannot be verified. They explain how to stop the fleet manually, confirm its exit and start the service before retrying; restart never automatically signals or takes over that fleet. Rollback messages distinguish a surviving recorded PID from a verified running service.
