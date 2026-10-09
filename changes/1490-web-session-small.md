---
section: Security
---
- **Web sign-in and setup page hardening (#1490):**
  - On this computer's own dashboard, a stale `__Host-agend_session` cookie no longer hides a valid `agend_session` one: an ended secure session made a signed-in browser look signed out. Writes are checked against the session that actually signed in. The public link still accepts only its `__Host-` cookie.
  - Polling an Apply (and a token or binding apply), which a page does for up to ten minutes while you wait, no longer counts as activity, so it does not keep an idle session alive (#1373).
  - The `agend setup` page now sends a Content-Security-Policy that runs only its own inline script and style (a fresh nonce per page), plus `X-Frame-Options: DENY`, so it cannot be framed by another site.
