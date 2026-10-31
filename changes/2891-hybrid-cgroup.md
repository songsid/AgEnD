---
section: Fixed
---
- Updates and `agend restart` no longer refuse with "fleet ownership could not be verified" on systemd hosts in the hybrid cgroup layout (WSL and older distros), where each process lists both a cgroup v2 and a v1 `name=systemd` row.
