---
section: Fixed
---
- Before restarting a carried kiro 2.34+ conversation, AgEnD verifies its owned V2 copy, saves the exact frozen classic rows to a private checksum-verified archive, then removes only those rows while the instance is stopped. An abandoned carry pin can be repaired before empty replacement sessions are considered; incomplete proof holds the instance instead of starting fresh. `agend kiro restore-classic` restores a verified archive without overwriting existing data (#2598).
