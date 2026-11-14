---
section: Fixed
---
- Fixed a message sent to a busy agent getting ❌ and a "please send it again" notice although the agent had it. Claude Code and Codex sometimes take several waiting messages together as one; AgEnD now recognises each of them, and no longer pastes such a message a second time after a restart.
