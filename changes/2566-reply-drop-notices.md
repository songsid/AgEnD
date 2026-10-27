---
section: Fixed
---
- **Possible missing-reply false alarms stay out of the channel and the mirrored web chat (#2566).** Retrying and unconfirmed delivery are recorded only in daemon.log and the instance's Log tab. Only a recovery that fails gets a short warning in the chat: it says it may be a false positive, never recommends `/clear`, and is rate-limited per instance.
