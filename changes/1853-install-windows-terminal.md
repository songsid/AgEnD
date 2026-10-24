---
section: Changed
---
- **The Windows installer opens in Windows Terminal when it is installed.** The elevated installer window used to be the old blue console, where Chinese text could turn into boxes. With Windows Terminal present (it comes with Windows 11), the installer and both desktop shortcuts open there instead; the window you pasted the command into still waits and reports how the install ended (or that its window was closed early). Without Windows Terminal nothing changes, and `AGEND_INSTALL_TERMINAL=conhost` keeps the old window. The live progress line of each long step no longer adds a new row every second in the old console, and its Chinese text no longer turns into mojibake (#1853).
