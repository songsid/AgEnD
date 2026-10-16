# Host-observed Canvas effect budgets (#1629)

This is an unmounted policy module, `src/ui/shared/effect-profiler.js`. It opens no storage, installs no observers or timers, reads no message content and creates no frame. The later registry supplies host observations and must physically remove an iframe when `remove` becomes true. This module alone does not stop Worker work. Product mounting is still disabled.

## Evidence and limits

The [Canvas-specific delta](https://github.com/songsid/AgEnD/issues/1629#issuecomment-6206224282) retains r3's ready-only inbound channel. There is no RTT/pong or Worker-reported cost. Host rAF cadence and host long tasks measure host responsiveness, not Worker CPU/GPU work, memory, internal FPS or event latency. `loadMs` is the first host-observed load elapsed time; it never comes from the child.

The [earlier browser probes](https://github.com/songsid/AgEnD/issues/1629#issuecomment-6197309471) found no usable container attribution in ordinary Chromium same-site/cross-site probes, no child task in forced out-of-process probes despite a passing host task control, and no Long Tasks support in Firefox. Same-site does not guarantee same-process execution. The [Long Tasks processing model](https://w3c.github.io/longtasks/) allows excluding other-process work and unknown culprit information. No new native browser or real-Safari attribution run is claimed by this PR.

The caller forwards an attributed task only when it matches that exact host-owned frame. Otherwise the host task is a conservative active-group fallback. Both can lower the budget. Missing attribution and an unavailable Long Tasks API are `null` / `unknown`, not zero effect cost. Unrelated host work can therefore pause a light effect. This false-positive risk is intentional; caps, human Resume and explicit opt-in remain necessary. `ok` reports only the measured host budget.

## Time and budgets

| Contract | Standard | Constrained |
| --- | --- | --- |
| Host rAF ceiling for the relative floor | 55 fps | 50 fps |
| Host-observed long task ceiling | 50 ms/s | 25 ms/s |
| Window | trailing 2 s | trailing 2 s |
| Warmup ignored | first 1 s | first 1 s |
| Sampling spacing | at least 1 s | at least 1 s |

One profiler belongs to one admitted mount and device class. Its required `baselineFps` comes from a visible host rAF measurement over a full 2 s with **no effects mounted**, before the first mount and again before a human Resume. The effective floor is `min(55 or 50, baselineFps * 0.9)`, so an idle 50 Hz or power-limited 30 fps host does not deterministically pause everything. Unknown, zero, non-finite or greater-than-1,000 fps calibration refuses construction. No manifest, effect, profile POST or active-effect sample may supply it. The future adapter must enforce this prerequisite before mounting; no calibration fallback is allowed. A page/device epoch may share one pre-effect baseline across the frame pool. A power/monitor change mid-mount can still cause one conservative pause; Resume removes the active pool and measures afresh rather than learning a running effect's jank. See the [review correction](https://github.com/songsid/AgEnD/issues/1629#issuecomment-6206449444). No effect manifest sets its budget. The first complete window ends at 3 s. A bad window degrades (low quality, 30 Hz pointer hint); two further consecutive bad windows pause, producing `remove:true` at 5 s under a continuous bad feed. A healthy window resets the consecutive count but does not silently restore normal quality in that mount. A delayed callback evaluates one current window, never invents missed windows. Removing a frame remains the registry's responsibility, not a timer promise that can kill work during a frozen host event loop.

`frame()` takes time from the host's monotonic clock. FPS uses the entire fixed window, so a short smooth burst followed by a stall cannot appear healthy. Task duration is intersected with warmup and the current window. The observer must supply only actual host entries once; the module is not an untrusted telemetry endpoint. Retention is bounded to 2,048 rAF timestamps and 256 task intervals. Overflow degrades instead of turning dropped evidence into health. Clock errors, non-finite/negative time or a monotonic rollback permanently pause that mount. The first pause reason is immutable, so later gate or clock failures cannot change whether the registry records a budget pause.

Hidden tabs stop forwarding immediately and require removal at 10 s. Returning sooner resets warmup/window history, so background rAF throttling is not counted as visible jank. A delayed visibility callback after the removal deadline cannot revive the mount. Reduced motion, Save-Data, the viewer switch off, or unknown page gates require immediate removal. Human Resume creates a new mount; no late observation revives the old one.

## Pause history and future storage adapter

`newEffectPauseHistory` and `recordEffectPause` are pure bounded transformations for a single content id and device class. Three pauses within a rolling 24 h turn that version off for that class. Off is sticky even after the timestamps age out; a new content id or another class has separate history. Calendar time uses wall time, clamped to the last recorded wall instant on rollback, so a rollback cannot age out pauses. A forward jump can expire timestamps. Invalid persisted state refuses rather than silently clearing it. Inputs and returned arrays are independent snapshots.

The future browser adapter must key and persist this history per id/class, preserve off through human Resume, fail closed on unreadable storage, and record probation before mounting. A leftover probation marker means an interrupted launch; it does not prove an effect caused a freeze. Probation persistence, profile upload/retention, observers, registry removal and UI are explicitly not implemented here.

## Verification and rollback

Focused tests execute the real exported module with host-owned deterministic clocks and feeds. They pair threshold boundaries, timing/order/hidden controls and calendar rollback with healthy cases. Source checks pin the absence of browser side effects or child-message input. Compile-valid reversals cover the changed policy. No live fleet, service, account, default tmux or browser is used by these tests.

Rollback is reverting this unmounted module and tests. No install/service/restart behavior, migration, configuration or startup work changes.
