---
section: Added
---
- **Settings → Web → Web authority (#1939, step 2a).** The web authority settings are now in the dashboard.
  - **Switches:** whether web messages carry the signed-in account's authority, and "Only this computer can authorize". A host in `web.allowed_hosts` that reaches the dashboard from elsewhere is called out while the second one is off.
  - **How long:** the hours a session's authorization lasts (1–48, default 48).
  - **Authorized sessions:** each one's device, account, and until when.
  - **Revoke web authority:** makes every authority given so far read as none and ends every authorization, without signing anyone out.
  - The switch is on by default: a session carries authority only once its account confirms it from Discord or Telegram. Every change here applies at once.
