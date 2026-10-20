---
section: Added
---
- **An "AgEnD 重新啟動" desktop shortcut on Windows**, beside "AgEnD 儀表板". It asks first ("確定要重啟 AgEnD 嗎？…", "Restart AgEnD?…"; no by default), then runs `agend restart` in the Linux and as the user AgEnD was installed in (recorded at install time, not assumed), shows `agend status`, and waits for Enter. When WSL or AgEnD isn't there, it says so; it never shuts WSL down. **Existing installs:** pasting the Windows one-liner again on a PC that already has AgEnD only offers to add or update the two shortcuts. No WSL, backend or setup step is redone.
