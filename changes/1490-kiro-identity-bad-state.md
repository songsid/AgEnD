---
section: Fixed
---
- **An unreadable kiro identity record is no longer overwritten (#1490).** When the file where AgEnD records which kiro conversation each instance owns could not be fully read (for example one malformed entry beside valid ones), the next launch replaced the whole file with a single new entry, and the instance's other directories or credential profiles lost their conversations. Now that file is left exactly as it is, nothing in it is given up, and the launch runs without conversation isolation, with a warning naming the file, until it is repaired or removed.
