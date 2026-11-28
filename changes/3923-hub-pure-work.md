---
section: Fixed
---
- Use about a third less Hub CPU per message than beta.28 (synthetic measurements), combining the earlier direct-message projection fix with exact-byte reuse of pure cutover facts and checked scalar version reads. Fresh authorization, revocation and version-floor checks still run. The 100 ms CPU target and higher concurrent-user capacity are not claimed.
