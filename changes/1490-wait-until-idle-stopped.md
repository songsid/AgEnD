---
section: Fixed
---
- **`TmuxControlClient.waitUntilIdle`: check stopped and abandoned before the initial idle fast path.** Previously `waitUntilIdle` checked `this.isIdle(windowId)` before `this.stopped || abandoned?.()`, so calling `waitUntilIdle` on an already-stopped client (or with `abandoned` already set) resolved `true` whenever the target window was idle or unmapped outside the observation grace. In addition, `Daemon.writeMessageToPane` now checks the `waitUntilIdle` return value during native-queue fallback instead of continuing to re-paste or send a recovery `Enter` when the idle wait returns `false`. (#1490)
