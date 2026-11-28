---
section: Fixed
---
- **CLI diagnostics · Windows on this computer says why it can't reach Windows, not `spawn …powershell.exe ENOENT`.** On an AgEnD that is not in WSL (a container, a plain Linux server) or whose WSL has interop off or no PowerShell, Detect again now names the cause and what to do — run AgEnD on Windows/WSL or pair a Windows computer, turn interop on in `/etc/wsl.conf`, mount `/mnt/c`, install Windows Node.js — in English and Traditional Chinese. PowerShell is looked up on PATH, then on the mounted drives and through `wslpath`, and a daemon whose own working directory was deleted no longer makes it fail silently. And with no detection on record the dialog no longer also says "showing the last successful result".
