---
section: Fixed
---
- The Windows installer no longer reports every AI backend as failed after a successful install. Commands sent into WSL now reach Linux as given (`wsl --exec`); before, the distro's shell rewrote them. A resumed install shows the saved backend choice: Enter keeps it, or type a new list (#2718, #2720).
- Console sign-in opens the login page in the Windows browser through Start-Process; explorer.exe is used only as a last resort, after it had opened the Documents folder instead. Codex signs in with a device code (`codex login --device-auth`), which does not depend on WSL forwarding localhost.
- Before setup, the installer picks two adjacent ports that are free on Windows (not reserved, nothing listening, including another Linux's WSL relay) and in Linux, and gives them to AgEnD as `health_port` (dashboard and setup page) and `health_port`+1 (previews). It opens the setup page only once Windows can reach it.
