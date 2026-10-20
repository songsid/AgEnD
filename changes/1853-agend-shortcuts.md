---
section: Added
---
- **`agend shortcuts` makes the Windows desktop shortcuts from inside WSL.** For an install that predates "AgEnD 儀表板" and "AgEnD 重新啟動", or that is only ever updated with `agend update`: it runs the installer's own shortcut code in Windows PowerShell through WSL interop, for this Linux and your user. With interop off it says so and points to pasting the Windows one-liner again. After `agend update` in a WSL terminal without the shortcuts, one line suggests it, once; an update never puts anything on the desktop by itself (#1853).
