---
section: Changed
---
- **The Windows installer no longer restarts all of WSL by itself.** When a freshly installed Ubuntu isn't ready, it restarts only that Linux (`wsl --terminate`) and tries again. If it still isn't ready, it asks before restarting all of WSL, which would stop every Linux on the PC. The default is no; on no it stops and says how to carry on. The docs no longer suggest `wsl --shutdown` (#1853).
