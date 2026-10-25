---
section: Fixed
---
- **kiro: AgEnD reads the conversation an instance is really in (#2598).** AgEnD watches each kiro instance's conversation for its tool use and replies. It always looked in kiro's classic store first. When a classic conversation is resumed under kiro's TUI, kiro copies it to the TUI's session files and stops updating the classic copy. AgEnD then kept reading the frozen classic copy and never saw the instance's new work. AgEnD now reads the store of the engine the instance was launched on. A resumed instance follows its own conversation, not the newest one in its folder, which may belong to another instance in the same folder. Instances on an older kiro, where the engine is not known, are read as before.
