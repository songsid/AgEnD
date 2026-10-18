---
section: Added
---
- **Web authority: the server switch, revocation and sessions authorized once (#1939, step 2a).**
  - **`web.verified_authority.enabled`** (on by default since step 2c) is the server switch. While it's off, web messages record no authority, and every web authority already recorded reads as none in `delivery_status`. Turning it back on never brings that authority back.
  - **Authorized once.** A web message carries authority (`web-verified`) only from a session its account has authorized, once, for up to `max_session_hours` (default 48). The account confirms it on Discord or Telegram (step 2b).
  - **Revocation.** `/web revoke` now also revokes every web authority given so far, and ends every authorization. Turning "Only this computer" (`loopback_only`) on makes earlier LAN authority read as none, and turning it off again doesn't restore it. `delivery_status` says why a receipt reads as none (`downgraded`).
