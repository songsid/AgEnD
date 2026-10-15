---
section: Changed
---
- **Web: the sign-in page says how to get a code (#1854).** It used to say "Send /web to your AgEnD bot", which sent people who had already done that back to /web without mentioning that a code only exists after you press a sign-in button there. Now it reads "No code? Send /web in General, then press a sign-in button to get one." The `agend web --code` way in sits under a collapsed "No chat bot?". A wrong code says how to get a new one. A sign-in the server could not confirm (for example a public link whose notice did not go out) is no longer reported as a wrong code.
