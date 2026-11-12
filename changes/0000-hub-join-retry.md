---
section: Fixed
---
- **Hub: a refused or interrupted company-account connection no longer blocks the next one for 10 minutes (#0000).** After the Hub refused a connection (for example, an ended join code), Settings → Hub went back to an empty box with no explanation. Every new attempt in the next 10 minutes failed silently, even with a valid code, and a restart or another browser didn't help. Now:
  - The refused attempt stays on the page with the reason, for example "The Hub did not accept this join code: it may have ended or been mistyped…".
  - Starting again works: AgEnD first checks with the Hub that the refused attempt can't complete, then sets it aside.
  - An attempt started in another browser tab or session shows up in every admin session, and a held one can be recovered or cancelled from there.
  - If an attempt that might still complete blocks a new one, the page says so instead of waiting silently.
