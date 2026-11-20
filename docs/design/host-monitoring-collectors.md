# Host monitoring collectors — S-205

This implements the collector/cache slice of the approved [host-health design](host-monitoring-dashboard.md). History, alerts, the Host health page and agent footprint remain the following slices. The cron disk watcher is unchanged.

## Runtime and settings

Config parsing and pre-fleet setup are inert. Full Fleet startup and the single-instance cold-start path activate the runtime bridge after the existing memory sampler. Before collection, the bridge durably materialises absent `monitoring.enabled` and `monitoring.agent_footprint` as false through the lossless atomic Fleet writer. A concurrent monitoring edit or failed commit prevents collection; unrelated YAML remains intact.

Off creates no native provider, monitoring timer, history store, process scan or file. Cached reads cannot start it. A committed enable starts one 30-second sampler. Disk batches run every second sampler tick, independently of wall-clock corrections. Off/shutdown fences completions synchronously, clears the timer and cancels owned commands. Re-enable waits for the previous provider **and** physical disk-flight closure. An unconfirmed close retains ownership and reports failure/stopping instead of starting a replacement.

Settings reports collector capability only for an active, pinned Linux/macOS runtime. The Notifications card and both search surfaces additionally require real Host health page availability, which stays false until S-207. A collector-only beta therefore exposes no switch or dead search result. Agent footprint remains unavailable until S-209. A settings save applies after the atomic commit; rejected reloads/saves do not start collection. Accepted reloads reconcile the same owner. No monitoring startup is attached to `loadConfig`.

`GET /ui/host-health` returns the bounded cached DTO with no-store. It requires an admin browser session, including the existing public-link admin session. Read/guest/header-token access is refused. There is no query, path, command or immediate-probe parameter. Filesystem names, private paths, distro names and native command output do not enter the DTO.

## Platform sources and bounds

- CPU: OS cumulative ticks with a previous baseline, logical CPU count and Unix load. First/reset/hotplug/invalid baselines have unknown usage, never invented zero. At most 1,024 logical CPUs are represented.
- Memory: the existing `MemoryPressure.snapshot()` only. No second Linux/Darwin memory sampler is created. Its pressure, source timestamp and availability estimate remain distinct.
- Linux/WSL storage: a bounded kernel mount inventory and `df -Pk` on root, the Fleet-state path and the identified Windows backing mount. Network/unknown mounts remain unavailable. Relevant filesystems are deduplicated, not added together.
- macOS: bounded `mount` and `diskutil info -plist` for known paths, cached hourly; no APFS snapshot or volume-tree enumeration. Known shared-container capacity envelopes are grouped conservatively. Different quotas stay separate and retain a shared-container marker; their free bytes must never be summed. [Apple describes APFS container sharing](https://support.apple.com/guide/security/seca6147599e/web).
- WSL: automatic discovery launches a constant read-only PowerShell query from Linux `/`. Its WSL UNC working location (`wsl.localhost` or `wsl$`) binds the current distro; exactly one matching registration yields a drive letter only. It does not require the agent’s inherited distro/interop environment variables. [Microsoft documents locating the registered VHD path and why virtual free space differs from Windows capacity](https://learn.microsoft.com/en-us/windows/wsl/disk-space). Kernel mounts resolve that drive, including custom automount roots. Missing interop/name/registration, network mappings or ambiguity produce `backingDrive: unknown`; C is never assumed to hold the virtual disk.

When automatic identification is unavailable, `monitoring.wsl_drive` accepts one explicit uppercase drive letter (or an empty string for automatic). It is resolved only to a unique local mounted drive. It accepts no executable, arbitrary path or network share. Changing it drains the old provider before sampling the new selection. The Settings card contains an explicit mounted-drive selector and a passive cache-refresh action; both remain hidden with the card until S-207 supplies the page. The setting can already be persisted through the existing settings route/config editor.

One physical disk flight is owned at a time. Every command is an absolute native executable, without a shell or inherited account credentials. Output is capped at 32 KiB per helper. Each command has a 1.5-second kill timeout; the whole batch has a 2-second logical deadline. Cancellation/timeout returns missing data promptly but cannot release physical ownership early. There is no backlog or retry loop. Discovery is at most hourly per enabled provider; at most eight relevant volumes are returned. Slow/unavailable sources do not turn into healthy zeros. Samples retain their source time; the cache marks data stale after two missed intervals.

## Evidence and limits

Deterministic tests cover physical-drain ordering, stale result generations, clock corrections, default pinning, failed writes, concurrent edits, hot disable, cache-only authorization, WSL mapping, network refusal, CPU baselines and APFS shared/quota behavior. Platform cases use synthetic bounded output. The local native check is WSL only; macOS parsing/cache behavior is tested offline, not claimed as a native macOS run.

The native WSL environment lacked distro/interop environment metadata. The initial approach therefore stayed unknown. R1’s fixed-root UNC-bound query identified the registered backing drive automatically, and the actual collector returned a separate Windows volume alongside the deduplicated root/state filesystem without an explicit selection. The explicit mounted-drive fallback is also covered. These short checks are not the final one-hour overhead measurement. That measurement with both options enabled and final user-approved real-data captures remain required at S-209.

Rollback: persist monitoring false and wait for the owned flight to stop; revert this slice while retaining the default-off config. No cron change, cleanup of user workspaces, model request or provider-account access is involved.
