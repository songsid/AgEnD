---
section: Fixed
---
- **One out-of-memory kill no longer stops the whole fleet (#2015).** On Linux, everything an instance runs lives in the fleet service's cgroup. With systemd's default `OOMPolicy=stop`, the kernel OOM-killing a single runaway command (an agent's one-off script) stopped the whole service, every instance included, until `Restart=` brought it back. The unit now sets `OOMPolicy=continue`, so only the killed process dies. A killed CLI is restarted as a crash, and a killed fleet process is still restarted by systemd. An update rewrites the user unit with it, and `agend restart` and the update's refresh add it to older units and a legacy system unit. A unit that sets its own `OOMPolicy` keeps it.
