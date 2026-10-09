---
section: Fixed
---
- **Atomic file writes now include fsync.** Three files that used write+rename without fsync are fixed: `fleet.yaml` (save path in `FleetManager`), `web-sessions.json` (`WebSessionStore.persistNow`), and `update-marker.json`. All three now follow write → fsync(temp fd) → rename → fsync(dir, best-effort). A new `atomicWriteFileSync` helper in `src/atomic-write.ts` is shared by the update-marker and session paths; `FleetManager` uses the same sequence inline to preserve its pre-write validation step. (#1490 P3)
