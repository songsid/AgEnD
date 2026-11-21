# Host alert foundation (M3454 / S208, first slice)

This is disconnected groundwork, not a completed alert feature. Only new pure policy and fixed-bank storage modules are added; no collector, runtime, worker, API, Settings, Needs you, General, sysinfo, UI or cron path imports them. There is no new user-visible control, notification, sampler or default-on work. S208 remains incomplete until the later integration, real-data captures/user approval and merged post-green proof; S209 still owns the agent option and hour-long both-options measurement.

## Policy

- One injected-clock window per opaque resource. CPU warning/urgent dwell run independently; filesystem/backing warnings count distinct source samples. Duplicate cache publications cannot count as new samples. Source timestamps are reading identities, not a wall-clock ordering guarantee; current owner-fenced collector callbacks must be supplied in arrival order. Wall-clock rollback does not stall monotonic dwell. Missing/invalid readings reset unproved dwell and never resolve an active incident; a long sampling gap or monotonic rollback resets dwell.
- Defaults follow the approved design: CPU 90%/5min and 98%/10min, pressure elevated/2min and critical/1min, filesystem/inodes 85/95% over two samples, backing free below 60 GiB/two samples or below 30 GiB/immediate. Recovery uses the approved separate thresholds/hold times. Inodes have no current producer; this slice does not invent a probe.
- Restart restores an incident and its successful delivery time, not monotonic dwell. Reminders use 6h warning/1h urgent delays from a successful current-revision delivery; stale receipts do not advance the clock. Acknowledgement keeps the incident visible. Snooze is bounded to 24h, and escalation bypasses a warning snooze. Delivery orchestration, enabled-epoch fencing, coalescing and retry scheduling remain integration work.
- Threshold validation is bounded, rejects non-finite/order/type errors and can compare backing thresholds with a supplied cached capacity. It never probes a filesystem. Callers must supply null for unavailable/stale metrics and bound the resource-window inventory.

## Incident reserve

The two fixed names are the existing history cleanup's `.incidents` and `.incidents.tmp` companions. Their combined default is exactly the 4 MiB already reserved inside the existing 64 MiB history budget. Construction touches no files. Explicit open allocates both banks once using bounded, incompressible writes (not sparse truncate or zero-block optimism), checks physical allocation, fsyncs data/headers and the parent directory, and uses mode 0600/no-follow/single-link/owner checks. Integration must open it only in the existing enabled history worker, and close that worker physically before Off cleanup.

Writes use the inactive fixed bank: payload/fsync, then header/fsync. The digest binds sequence metadata as well as payload. Reopen selects the greatest valid sequence, or falls back after a torn/corrupt bank. Two invalid banks and partial creation fail visibly; they never silently reset incidents. A failed commit fences subsequent writes until reopen. A captured sequence rejects stale saves. No commit grows/truncates/renames the banks. Filesystem errors (including CoW or metadata space exhaustion) can still refuse a write; physical preallocation is not an unconditional promise that every filesystem can write at zero free space.

The strict versioned document admits only bounded numeric telemetry/opaque identifiers: at most 64 active, 500 resolved and 64 revision-bound pending records, with one pending per resource and a separate encoded-byte limit. Unknown fields, unsafe keys, sparse arrays and unbound pending records are refused. Thirty-day pruning, durable queue integration and acknowledgement authorization remain in the follow-up; this foundation has no handler or worker owner yet.

## Verification scope

The tests use synthetic resources, injected clocks and owned scratch files. There are no account/model/CLI/browser/real-Fleet/native platform probes or recursive state scans. The current host's file allocation check proves the scratch reservation only, not a native macOS/Ubuntu deployment campaign. No screenshots are needed for this invisible disconnected slice; the later actual UI is still subject to the user's capture gate.

A new sequence-header corruption control first failed (sequence 900 selected instead of the older valid bank). Binding the sequence into the digest fixes it. Six current-input reversals catch duplicate sample counting, missing recovery reset, warning resetting urgent dwell, a disabled checksum check sparse reservation and treating source wall time as an ordering clock. The mutation recipe records exact input/restored hashes and substitutions; all original sources were restored. Final restored results and compiler checks are recorded in `checks.json`; compressed logs are path-sanitized.

Rollback: removing these unused modules restores the prior tree without touching user state. Do not later remove an integrated incident owner without its Off/physical-close/known-file cleanup path. This PR does not change the S213 drive sidecar or its rollback-compatible YAML contract.

## R1: revalidate allocation on reopen

Review found that a checksum-valid bank with a sparse tail still passed the existing-file logical-size check. The bounded two-bank regression preserves headers/digest-valid payloads and the logical 128 KiB total, while truncating/regrowing only owned scratch tails to make the remaining extents sparse. It first failed because reopen succeeded; the fully allocated positive passed. Reopen now rejects unconfirmed physical allocation before loading state, without rewriting or reinitializing either existing bank.

The complete affected store file passes 17/17; canonical source/test typechecks have zero diagnostics. The original 126-test/six-reversal proof and mutation recipes belong to reviewed head `6b0a1b6c0c79af5cffc4d1fda794151d78bdfeb7` and carry historically; they were not repeated for this allocation-only correction. Policy and production consumers are unchanged. The release freeze was subsequently lifted; the foundation can proceed through normal review/CI readiness, while the later visible integration still needs user captures. No broad or native platform campaign.
