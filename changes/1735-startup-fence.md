---
section: Fixed
---
- **A fleet finishing its start after an update no longer clears another operation's progress marker (#1735).** It clears only the update it started from; a `/restart full` or a new `/update` begun meanwhile keeps its own. The old install's folder is named in the cleanup note only when it contains no control or invisible characters.
