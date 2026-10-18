---
section: Added
---
- **Web sessions record their account's authority (#1939, step 1: recorded only).** A web message, command or button click now says in its delivery receipt who authorized it:
  - **`web-session`:** a signed-in fleet admin's own account, on the dashboard reached directly, within 48 hours of signing in. The receipt names the session's device handle and whether the browser was on this computer or the network.
  - **`none`:** anything else from the web: the public link, a guest, an `agend web` sign-in, an older session.
  - **`platform`:** Discord and Telegram messages, as before.
  - `delivery_status` returns it and the event log notes each `web-session` message. Nothing acts on it yet: agents still treat web messages as recognition only.
  - `web.verified_authority.loopback_only` and `max_session_hours` set who qualifies.
