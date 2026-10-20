---
section: Added
---
- **The Windows installer can install a separate Ubuntu just for AgEnD.** On a PC that already has Ubuntu, the recommended choice installs one named `AgEnD` (or `AgEnD-2`, …), leaving yours untouched. The other choices are using your existing Ubuntu (its settings change) or quitting. On WSL 2.4.4+ it uses `wsl --install Ubuntu-24.04 --name`; on older WSL it imports Microsoft's official image after checking its SHA256. Everything afterwards uses that Linux: the setup, both shortcuts, `agend shortcuts` and the repair path. A later run reuses it. Both shortcuts now say which Linux and user they open, and `agend shortcuts` asks before pointing them at a different one (#1853).
