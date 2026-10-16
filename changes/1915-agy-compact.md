---
section: Fixed
---
- **Compact no longer wipes an agy conversation (#1915).** On agy, AgEnD's compact (the web chat's **Compact** button and `/compact`) sent `/clear`, which erased the whole conversation instead of compacting it.
  - It now sends agy's own `/compact`, which summarizes the conversation in place (verified on agy 1.3.6).
  - On an agy known to be older than 1.3.6 it is refused, nothing is sent, and the reply says to update agy.
