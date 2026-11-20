---
section: Fixed
---
- Signing in to the dashboard over your fixed public link (a named tunnel) now survives `agend update` and restarts: when the link reopens on the same hostname, you stay signed in. Closing the link, `/web revoke`, or changing its hostname or token still signs everyone out, and sessions keep their usual time limits. The temporary link still needs a new sign-in, because its address changes each time.
