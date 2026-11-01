---
section: Added
---
- **A web-only fleet: the person at the AgEnD computer is its admin (#2910).** On a fleet with no Discord or Telegram connection, a browser signed in with `agend web --code` and used on that computer is verified at once as **This computer's admin**:
  - Its messages reach agents as `via web (verified)`; the receipt's `authority.actor` is adapter `host`, user `operator`.
  - Its own **Apply** confirms its Settings changes, such as **New agent**, so `agend settings confirm` is no longer needed.
  - Never from another machine or over the public link. A code sent by chat is not the host's. After a revocation, sign in again with `agend web --code`.
  - Fleets with a chat connection are unchanged.
