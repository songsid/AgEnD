---
section: Changed
---
- Settings → Version and update → "Updates on this machine": a Fleet that isn't running as a service gets **Install as a service**. After you confirm, AgEnD restarts as a service; every Agent stops briefly and comes back on its own. The page waits for AgEnD to come back and says whether it now runs as a service. If AgEnD can't install it, the page says why, and AgEnD keeps running as before.
- `agend install` on a computer where AgEnD was started by hand now waits until that AgEnD has stopped before it starts the service (up to five minutes, as `agend restart` does), and checks first that the service can start. If the service still can't start, AgEnD is started again the way it ran before.
