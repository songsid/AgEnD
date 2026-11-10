---
section: Changed
---
- **One sign-in box for authenticator and device codes (#3486).** Enter the authenticator app’s six-digit code or paste an eight-character device sign-in code. Complete codes submit automatically, with an 800 ms wait for a typed six-digit prefix that could still be a device code. Failed values never auto-loop; the visible Sign in button remains for explicit retry. Wrong-code and paused states explain the next step, and phone reachability help stays on the page. Authentication and public-link rules are unchanged.
