---
section: Fixed
---
- **Pasting Claude Code's sign-in code no longer ends in "CLI exited, credentials unconfirmed" (#2599).** AgEnD put Ctrl+U in front of every code it sent to a sign-in. Claude Code 2.1.319 and later reads its prompt raw, where nothing consumes it, so the server was sent the code with that byte in front and refused it. A code is now sent as typed (Kiro's prefilled start URL and region still get the Ctrl+U they need). Claude Code 2.1.319 also words a refused code `Login failed: That code wasn't accepted`; both wordings are now reported as a rejected code.
