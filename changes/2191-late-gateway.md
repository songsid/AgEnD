---
section: Fixed
---
- **Keep retired Discord startup offline (#2191).** A late gateway response can no longer create a new socket after retirement and expose an unhandled handshake error during native recovery.
