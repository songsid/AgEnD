---
section: Fixed
---
- **The install one-liner no longer reports a failed install when it could not take the install lock (#2284).** It used to add "Installation failed … run this installer again" after the installer's own reason. It now says AgEnD was not installed this time because the lock could not be taken: let a running install finish if that is the reason shown, otherwise do what the reason says. The message is in Chinese when the shell's locale is Chinese, and the exit code is 75. A real failure keeps the old message.
