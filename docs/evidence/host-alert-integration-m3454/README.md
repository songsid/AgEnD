# Host alert integration — S208 B

This unstacked integration starts from dev `9db1e0b2`, after the incident foundation merged and its post-merge checks passed. No cron file or webhook is changed.

The existing persistence worker owns the preallocated incident banks. Its active bit fences all writes; the low-water bit only pauses SQLite. The coordinator durably records transitions before publication/delivery, coalesces changes, keeps one physical notification in flight, and advances reminder stamps only on a successful delivery callback. Failure backoff survives restart. Off revokes queued work and waits for the existing worker's physical close before known-file cleanup. A platform send already dispatched cannot be recalled; crash/send/commit ambiguity can cause duplicate delivery, not exactly-once delivery.

Cached host incidents appear only to current administrator sessions on poll, initial/live SSE and action routes. Acknowledgment keeps a problem visible. Snooze is bounded, and urgency bypasses warning snooze. General is explicitly opt-in to avoid duplicates with the unchanged stopgap script. Its summary points to Fleet → Host health without opening a public link. `/sysinfo` adds cached incident count, coverage and age without new probes.

Threshold/destination preferences use a separate bounded atomic 0600 sidecar. They never add YAML keys or change the drive sidecar schema. Settings confirmation includes the exact captured preference bytes; unknown fields and unsupported resource/threshold values are refused. Off retains preferences but runs no alert timer, worker or retry. Inode counters remain unavailable because the existing collector does not supply them.

## Validation

`validation.json` records the terminal affected suite, production/test type checks, build, and the all-Settings CI gate. The three reversal logs show semantic failures for an unsuccessful-delivery stamp, a stale epoch, and read-session exposure. Their exact input hashes precede the later queue-cancellation repair; final tests separately pin queued-edit refusal and an edit interrupted by Off. These are scoped checks, not a live provider or native notification campaign.

The initial real health images were retained. A Settings capture first exposed a missing preference load: Settings uses raw fleet config, so the separate admin read is now loaded into its own context. A second capture exposed phone controls below 44 px; existing switch-label geometry and a scoped shared phone rule fix that, with no allowances added. Only affected Settings/incident examples were retaken. The full Settings gate then passed 124 checks.

## Captures and scope

All eight originals were visually inspected for layout and public safety. The real health and Settings images contain actual bounded host samples in an isolated product fixture with a synthetic agent name. Alert and Needs you incidents are explicitly synthetic overlays, including urgency and an acknowledged issue. They prove rendering, not a real native threshold incident or platform delivery. The one-hour run with both options remains S209, as does agent footprint.

The first pair uses the same Host health UI; subsequent changes affect Settings controls, the Needs group/reason, and queue lifecycle. No capture claims native macOS/Ubuntu execution. Raw host snapshots, private command output and intermediate invalid captures are not published.

**USER LOOK HOLD:** the integration must not merge until the Leader forwards the user's capture approval. Reviewer clearance alone does not lift that hold.

- [Real desktop health](after/real-health-desk-light-en.png)
- [Real phone health](after/real-health-phone-dark-zh-TW.png)
- [Real desktop Settings](after/real-settings-desk-light-en.png)
- [Real phone Settings](after/real-settings-phone-dark-zh-TW.png)
- [Synthetic desktop alerts](after/fixture-alerts-desk-light-en.png)
- [Synthetic phone alerts](after/fixture-alerts-phone-dark-zh-TW.png)
- [Synthetic desktop Needs you](after/fixture-needs-desk-light-en.png)
- [Synthetic phone Needs you](after/fixture-needs-phone-dark-zh-TW.png)
