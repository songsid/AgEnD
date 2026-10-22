---
section: Fixed
---
- A read error on a helper's output pipe no longer crashes the fleet. If `tar` fails while `/login` unpacks the downloaded cloudflared on macOS, that public link now fails with "cloudflared could not be installed". If the login-shell lookup for a backend CLI fails, that lookup now counts as not found (#2243).
