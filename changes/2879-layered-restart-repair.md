---
section: Changed
---
- `agend restart` (and so `agend update`) repairs the user's systemd manager first when it runs without its socket (WSL can replace `/run/user/<uid>`) or does not run, as root; a user who is not root gets the exact `sudo` command instead. The Windows shortcut **AgEnD 重新啟動** checks the same layers and, only if systemd is down and you type the Linux's name, restarts just that Linux. Existing shortcuts get this with `agend shortcuts`.
