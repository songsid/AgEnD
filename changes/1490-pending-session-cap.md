---
section: Fixed
---
- **A public-link sign-in waiting for confirmation no longer knocks an already-signed-in session off the cap (#1490).** Creating the pending candidate used to count against the same session limit as live sessions, so with the store full a public login that had not finished yet could evict a working local session — and the candidate itself still could not authenticate. Pending candidates now share a cap only with other pending candidates. The live-session cap is applied when the public notice completes and the candidate is admitted.
