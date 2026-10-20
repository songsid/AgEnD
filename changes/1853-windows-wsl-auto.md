---
section: Changed
---
- **The Windows installer's WSL stage asks almost nothing.** After a reboot it carries on by itself once you log back in (a one-time resume, cleared at the start of every run and when the install finishes). It installs Ubuntu-24.04 on the system drive, or on the local disk with the most room, and shows where; there are no numbers to type and no "got it?" prompt. Ubuntu's first-run window, which asked for a Linux user and password, is no longer opened: WSL is restarted and the setup retried instead. An Ubuntu that is already there is still asked about, with what would change, and the default is now no. A resumed install keeps using the Ubuntu chosen before.
