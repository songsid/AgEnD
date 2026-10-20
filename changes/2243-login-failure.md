---
section: Fixed
---
- A failed browser-terminal listener or cloudflared output pipe during `/login` now ends only that login and reports the reason and next step in chat, instead of crashing the fleet. Public-link failures keep the HTTP 429 explanation; local links explain loopback access, HTTP and LAN/WSL troubleshooting (#2243).
