---
section: Changed
---
- Settings → "Revoke web authority" is now "Revoke other devices' authorization": only a verified owner can use it (the server answers 403 to anyone else), the confirmation lists the devices that lose their authorization, and the owner's own session stays verified. The session menu and Settings → Devices show one of four roles (Owner ✓, Admin · not verified, Guest, Read-only), and a browser whose host sign-in lost this computer's admin authority can re-bind in place with the sign-in code from `agend web --code`. The session menu now has its own border so it no longer blends into the sidebar (AGEND-138).
