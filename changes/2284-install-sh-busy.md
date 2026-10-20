---
section: Fixed
---
- **The install one-liner no longer calls it a failure when another AgEnD update is still running (#2284).** It used to add "Installation failed … run this installer again". It now says that another update is in progress and to let it finish (in Chinese when the shell's locale is Chinese), and exits with code 75. A real failure keeps the old message.
