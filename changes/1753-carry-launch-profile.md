---
section: Fixed
---
- **A Claude profile switch never reports the conversation as carried when the CLI starts on another login (#1753 follow-up).** If a profile switch joined a restart that had read its configuration before the switch was saved, that restart launched the old login, yet the switch could still copy the conversation into the new profile and reply "carried". The copy now happens only when the login being started is the one the switch moves to. Otherwise the reply reports `carry_failed` with the login actually launched, and the handover goes out. When that login is the old one, the CLI simply resumes its own conversation. When it's a third one, it starts fresh.
