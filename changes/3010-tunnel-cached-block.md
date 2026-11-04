---
section: Fixed
---
- **Deleting a stale tunnel lease no longer requires a restart before `/web` works again (#3010).** When a tunnel process was killed mid-start and left an unrecorded `tunnel.lease` file behind, `ManagedTunnel.reap()` cached the manual-cleanup block in memory. Subsequent `/web` attempts returned `lease-held` from that cache instead of re-checking the lease file, so `/web` kept failing even after the operator deleted `tunnel.lease` as instructed until `agend restart`. Each start attempt now re-runs the lease check while still blocking whenever a live foreign lease remains on disk or an in-process tunnel stop could not be confirmed.
