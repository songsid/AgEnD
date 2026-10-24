---
section: Fixed
---
- Keep possible missing-reply false alarms out of channel and mirrored web chat: retrying and unconfirmed delivery are log-only. Only an unsuccessful recovery gets a short warning, while diagnostic details remain in daemon.log and the instance Log tab.
