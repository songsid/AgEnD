---
section: Fixed
---
- **An unreadable kiro identity record is no longer overwritten (#1490).** When the file where AgEnD records which kiro conversation each instance owns could not be fully read (for example one malformed entry beside valid ones), the next launch replaced the whole file with a single new entry, and the instance's other directories or credential profiles lost their conversations. Now that file is left exactly as it is and nothing in it is given up. The launch still starts a new, isolated conversation as the instance's own agent, but does not record it, and a warning names the file; until the file is repaired or removed, each launch starts a new conversation.
