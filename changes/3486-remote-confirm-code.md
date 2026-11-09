---
section: Added
---
- **Optional: ask for an authenticator code to confirm from other devices (#3486).** `web.verified_authority.remote_confirm_code` (Settings → Access & security → Web authority; off by default, needs an authenticator set up) makes every session that is not the AgEnD computer's own browser confirm each change with that change's code instead of Apply now. Turning it off, or replacing/removing the authenticator, asks for the current code off the AgEnD computer. "Only this computer can authorize" now blocks the code too. Any signed-in admin can set up the authenticator, and a chat fleet can use it for these codes (not for signing in from outside).
