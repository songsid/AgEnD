---
section: Added
---
- **Authorize this browser over the temporary public link, opt-in (#1939 §0.3).** A new option in Settings → Web → Web authority, **Also over the temporary public link** (`web.verified_authority.quick_link`), is off by default. When on, a browser signed in over the link `/web` opens can be authorized with your account's Confirm card, as on this computer. Turning it on is confirmed in a General or on the host, never by the browser asking. It also ends every authorization given so far, so each browser confirms again. Turning it off applies at once. The authority ends with the link: Close, `/web revoke`, its expiry, a restart, or the option turned off. With the option off, the row under the composer on that link says how to turn it on.
