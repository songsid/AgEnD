---
section: Added
---
- Web: **Authorize this browser** can work over your own named-tunnel hostname too (#2453). It is opt-in and off by default: Settings → Web → Web authority → **Also over my named link**, and turning it on is confirmed in a General or on this computer. Only the exact configured hostname counts; a quick tunnel never does. The Confirm card says "over your named link (the internet)", and the device list and receipts mark it. Its authority ends with the link (Close, `/web revoke`, expiry, a restart) or when you turn the option off, which also makes its receipts read as none at once. "Only this computer can authorize" still wins.
