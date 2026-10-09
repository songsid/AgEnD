---
section: Fixed
---
- **Telegram General bot addressing (#1148/#754):** at the forum root, an explicit command suffix is checked before shared dedup, even without a message ID. A wrong or unknown receiving username cannot consume the intended bot's message or run its General command. Bare commands, Classic/present-thread behavior and exact alias forms are unchanged.
