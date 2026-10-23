---
section: Added
---
- **A fleet that fails to start after an upgrade is now also reported in chat (#2490).** The notice that `agend` commands and `agend doctor` show (#2481) is posted once to General, or to the first admin's DM when there is no General. It names the version, how to go back and where the error is, for someone who uses AgEnD only from Discord or Telegram. It is sent on the third failed start of that version, by the failing start itself, through the platform's API. It is posted once per version, never repeated in a crash loop, and best effort.
