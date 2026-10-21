---
section: Fixed
---
- **The Windows one-liner repairs a broken AgEnD instead of starting over.** It now recognises a PC where AgEnD's data is there but `agend` no longer runs, for example after an update was cut off half way. In that case it re-runs the official installer only in that Linux, on the channel of the version found on disk, so a beta stays a beta. On any host, a one-liner target from before the new installer is now installed by the newest installer, which repairs first. It then checks that `agend --version` works and offers the shortcuts as usual. No WSL, backend or setup step is redone, and your fleet's settings and data are kept (#1853, #2264).
