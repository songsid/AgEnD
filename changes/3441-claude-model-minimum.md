---
section: Fixed
---
- When Claude Code reports that a model requires a newer CLI, AgEnD checks the installed version. If it is already sufficient, the instance restarts once with the same conversation; otherwise, a plain notice asks for a Claude Code update. Automatic repairs never loop.
