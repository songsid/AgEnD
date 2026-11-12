---
section: Fixed
---
- **Connecting one AI account in Settings is no longer refused by another's.** There was one sign-in window for the whole fleet, so a Claude Code sign-in nobody finished made Grok's Connect say "Your claude-code account is already being connected. Use /login cancel first." Each backend now has its own window: different backends connect side by side (the same backend, an install, a keep-alive refresh and Sign out still take turns). Closing the Connect dialog ends the sign-in it started instead of leaving it running for ten minutes. When a start is refused because that backend is already connecting, the dialog says so in plain words and offers **Cancel that connection and continue** — no chat command to type.
