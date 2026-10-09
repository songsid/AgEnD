---
section: Fixed
---
- **`TmuxControlClient`: observation age uses monotonic clock.** `observationResetAt`, `inObservationGrace`, `lastOutputAt`, and `isIdle` now all use `this.mono()` (backed by `performance.now`) instead of `Date.now()`. A wall-clock jump (NTP, daylight saving) can no longer cause a pane to appear idle before the silence window has elapsed or to remain in grace longer than expected. (#1490 P3)
- **`TmuxControlClient.waitUntilIdle`: resolves `false` when the client is stopped.** Previously it resolved `true`, which would have told callers the pane was idle and triggered delivery into a stopped client. (#1490 P3)
