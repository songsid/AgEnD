---
section: Added
---
- Added a Hub authorization refresh hook that reconnects members without retiring them, with version checks covering existing links and pending handshakes. Revoking one fleet now immediately reconnects other fleets on the new global authorization version while preserving their pairing. Group permissions remain off until their separate composition.
