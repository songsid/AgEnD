---
section: Fixed
---
- Use about a fifth less CPU per Hub direct-chat message in the matched synthetic measurements by projecting only the changed message and avoiding an unused duplicate room proof. Fresh authorization, revocation and version-floor checks still run; version-only checks skip copying the transport graph. Add opt-in phase timings for diagnosis without logging message content.
