---
section: Fixed
---
- **Opening a login's public link no longer risks freezing the whole fleet, and if the fleet does freeze, the log now says where.**
  - **The checks no longer run on the fleet's main thread.** The checks a login's public link makes on the computer's files — finding your own `cloudflared` on `PATH`, checking it can run, recording the tunnel's lease — used to run there. A `PATH` entry or folder on a network or automounted drive that stopped answering held it, so systemd's watchdog stopped every agent after a minute (reported twice on native Linux, #3009, and on WSL, #1880). They now run in the background with a time limit: a drive that never answers ends that login's public link with a reason, falling back to AgEnD's own copy of `cloudflared` when your own cannot be found in time, and every other agent keeps running.
  - **daemon.log names a freeze.** If the fleet's main thread ever stops for 15 seconds, a line is written from a separate thread naming what it is waiting on (its state, wait channel and system call), before systemd's watchdog acts. A freeze used to leave no trace in the log. (#3009)
