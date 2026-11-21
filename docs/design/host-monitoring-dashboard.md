# Host health in the Fleet web dashboard — proposal

**Approved design; delivery is split into small dev-only slices.** The original design captures are inert prototypes with synthetic snapshots. S204–S206 provide the off-by-default setting, bounded collectors and history. S207 adds the administrator Host health page; its real-data captures remain on user-approval HOLD. Alerts, agent footprint and the one-hour measurement with both options on remain S208/S209 acceptance, not completed claims.

## Optional Settings switch — off by default

Put **Host monitoring / 主機監測** in **Settings → Notifications**, using the shared Settings card, labelled switch, hint and Save bar. The switch is **Off** initially. One-sentence hint: “When on, samples every 30–60 seconds; estimated 2–4 MiB RAM and 1–4 MiB of local writes per hour.” /「開啟後每 30–60 秒取樣；估計使用 2–4 MiB 記憶體，每小時本機寫入 1–4 MiB。」These were planning estimates, not an implemented service benchmark. The delivered Settings hint now states the 30–60 second cadence and 64 MiB local cap, and says memory/write costs are still being measured; S209 must replace estimates with the required one-hour real measurement.

Proposed persisted settings: `monitoring.enabled: false` and `monitoring.agent_footprint: false`. Off must be a stored boolean **false**, never deleting the key or falling through to a future default. A missing key is also treated as false; migration materialises false before any monitoring startup. No future default change enables an existing installation.

**While off, monitoring does nothing:** no collector/provider discovery, process snapshot, timer, worker, notification retry, history store or history file. Page requests return the disabled state without probes. Independent pre-existing Fleet memory admission checks and the operator's cron script are unaffected. First enable creates the bounded store and schedules work only after the setting is committed.

Turning off persists false, cancels schedules/outbox, drains or terminates the bounded monitoring worker, closes and removes only the dedicated monitoring history/incident store and its known sidecars, and stops monitoring notifications. There is no “recovery” claim from disabling. Do not retain a hidden history file. Interrupted shutdown gets one fixed-path cleanup at startup with false, without opening/creating the store; no cleanup timer or directory scan. A cleanup failure is reported explicitly, never presented as a successful clean Off state; it cannot restart monitoring. Confirmation warns that recorded history will be removed. Re-enabling starts fresh.

**Per-agent footprint is a separate sub-option, also off by default.** When monitoring is on, the owner may enable **Include agent footprint / 包含 Agent 資源用量**. Its hint explains the extra process snapshot and estimated 2–8 MiB RAM plus 1–4 MiB/hour for 32 agents. With it off there is no PID enumeration, descendant attribution or managed-file sampling; the page says “Agent footprint is off” rather than showing zero. Turning the parent off cancels both, with no subordinate timer. Agent preference may remain explicitly false/true in config, but can run only when both booleans are true. The dashboard cannot start monitoring by opening it.

### Enabled overhead: bounded proxy on this host and estimates

A private, short-lived probe read Linux CPU/RAM/pressure counters and the two filesystem counters 10 times, then read at most 4096 `/proc/*/stat` rows in five snapshots. It read no command lines, environments or user-state trees. On this 6-logical-CPU WSL host, the final warm-cache sample had 368 processes. Host reads averaged **0.120 ms CPU / 0.327 ms wall** (max 0.232 / 0.589); process snapshots averaged **4.592 ms CPU / 4.613 ms wall** (max 5.271 / 5.290), reading about 107 KiB per snapshot. These are read-cost proxies, not a production collector, cold-cache guarantee or macOS/Windows benchmark.

Conservatively charging the combined host read every 30s (including disk counters that will actually run every 60s), those measured read costs alone project to 14.4 ms CPU/hour for host samples and an extra 276 ms/hour for one process snapshot/minute: **0.0004% and 0.0077% of one core**, respectively (divide by six for total-host CPU%). This excludes aggregation, persistence, discovery helpers and IPC. Do not present these tiny figures as total overhead.

| Enabled scope | Planning CPU budget | Incremental resident memory estimate | Local disk writes/hour estimate |
| --- | --- | --- | --- |
| Host metrics only, 2 volumes, 30s/60s | 0.01–0.05% of one core; about 0.002–0.009% total on this host | 2–4 MiB within the existing Fleet process | 1–4 MiB |
| Add agent footprint, 32 agents / observed ~368 process rows | Additional 0.02–0.2% of one core; about 0.003–0.034% total here | Additional 2–8 MiB | Additional 1–4 MiB |
| Monitoring off | 0 monitoring CPU | No monitoring buffers/worker/history allocation | 0 monitoring writes; configuration writes only when edited |

Write estimates assume compact bounded records: host/volume samples under 64 KiB payload/hour; 32 agents × 60 × 64 bytes ≈120 KiB/hour. Page/index/WAL amplification, rollups and deletion increase physical writes, so reserve the larger 1–4 MiB bands; they are estimates, **not measured disk traffic or hard guarantees**. No per-sample fsync; batch once/minute and account for WAL inside the 64 MiB cap. Alert traffic and restart discovery are extra bounded bursts. Slow WSL interop may briefly use a helper process, so peak memory needs later measurement; do not hide it in steady resident estimates. At 128 agents/4096 process rows, use the existing caps and report coverage; do not extrapolate the 32-agent numbers unchanged.

The process snapshot was ~38 times the host read CPU cost in this small warm-cache probe, so a separate off-by-default agent option is justified. After implementation, measure actual incremental CPU/RSS/physical writes for an hour on WSL, Ubuntu and macOS, plus capped-agent/slow-provider cases, before claiming these budgets. The proof here is an estimate backed by bounded read samples, with no persistent monitoring enabled on the host.

## The page

Add **Fleet → Host health / 主機狀態**. While disabled, show “Host monitoring is off” and a link to its Settings switch, without sampling or history. The enabled page answers: “Is this computer running out of something, what changed, and which agents are contributing?”

Reuse PageHead, cards, tabs, buttons, status tags and existing colour/spacing/type tokens. Desktop has adjacent CPU/memory trends and storage; phone puts storage first and pairs CPU/memory summary cards, with the active alert and lowest-space disk first. Ranges: 1h, 24h, 7d, 30d. Charts include units, peaks/minima and accessible text; missing samples remain gaps. Agent CPU, estimated memory and known managed-file bytes follow below, as cards on a phone.

The reference is a sampled resource overview with history, like the [GHES monitor dashboards](https://docs.github.com/en/enterprise-server@3.19/admin/monitoring-and-managing-your-instance/monitoring-your-instance/about-the-monitor-dashboards). Delivery uses Fleet UI and bounded local snapshots.

Show computer/platform, last successful sample and coverage beside the title. WSL figures mean **WSL**, not physical Windows CPU/RAM. A paired Windows Runtime is a separate computer, never added to local totals.

## Platform collection

| Platform | Storage | Memory | CPU/load and agents |
| --- | --- | --- | --- |
| WSL 2 | Linux root and Fleet-state filesystem; **separate Windows drive holding the current distribution's vhdx**. Read filesystem counters or bounded df on the identified drive mount, normally /mnt/&lt;drive&gt;. | Existing Linux available-RAM/swap/PSI snapshot, labelled “WSL memory”. Physical Windows memory is unavailable without a separate host collector. | Delta CPU counters, logical CPU count, load averages; one bounded process snapshot for known agent roots and children. |
| Native Ubuntu | Relevant local filesystems; deduplicate by filesystem identity. Available bytes, used %, optionally inode availability. No directory-size scans. | Existing /proc/meminfo and memory PSI reader. Unavailable PSI is unknown while RAM data remains useful. | OS CPU deltas/load, bounded PID/start-time process attribution. |
| macOS | Relevant APFS volumes. Cache volume/container identity; group System/Data aliases and **never sum shared free space**. Respect reported volume quotas. | Reuse bounded Darwin probe: vm_stat, swap and validated native pressure. Pressure is the headline; available RAM is labelled an estimate. Missing pressure is unavailable, never Normal. | OS CPU deltas/load and known-agent process counters. No recursive file or APFS snapshot enumeration. |
| Windows Runtime | Capability-negotiated native volume samples. Older/offline Runtime is unavailable/stale. | Native physical/commit counters; no invented macOS pressure or Linux PSI. | Native CPU/process-time deltas. Unix load is unavailable, never zero. This extension cannot block the required three local platforms. |

APFS shares container space ([Apple](https://support.apple.com/en-gb/guide/security/seca6147599e/web)). Linux PSI measures resource stalls, not simply RAM used ([kernel interface](https://docs.kernel.org/accounting/psi.html)). Windows free-space calls distinguish caller-available bytes from total free space ([Microsoft](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-getdiskfreespaceexa)). Windows has no Unix load equivalent in [Node's OS API](https://nodejs.org/api/os.html#osloadavg).

**Agent footprint (optional):** CPU is a percentage of the selected computer's total CPU capacity. Memory is an RSS estimate including descendants; shared pages may be counted twice. Shared services have a separate overhead row. No command lines, environments, prompts or credentials enter telemetry. Managed-file size uses existing accounting/known-file metadata only. Workspace size is **Not measured** without cheap accounting. No periodic du, Docker size query or recursive Fleet-state scan.

### WSL backing drive

The Settings drive preference is stored atomically with mode 0600 in `host-monitoring-settings.json` under the Fleet state directory, separate from history and `fleet.yaml`. Only `enabled` and `agent_footprint` belong in the YAML monitoring mapping. Startup and ordinary config saves migrate a legacy `wsl_drive` through the lossless config writer. Missing or malformed sidecars use automatic detection. Older releases ignore the sidecar; re-upgrading retains it. Settings responses project the choice without putting it into the persisted FleetConfig, and confirmation fingerprints cover the sidecar. Removing monitoring history does not remove this preference.


Linux free space alone is insufficient: virtual disk maximum capacity can exceed the Windows disk's capacity. [Microsoft documents the distinction and locating a distribution's vhdx through registered BasePath](https://learn.microsoft.com/en-us/windows/wsl/disk-space#how-to-locate-the-vhdx-file-and-disk-path-for-your-linux-distribution).

At startup, after a path/config change and at most hourly, perform a bounded constant-script read of the current distribution's registration. Resolve its Windows volume and mounted Linux path, honouring custom automount roots. Cache mapping and volume identity. Never search user directories or enumerate vhdx files. Sampling reads filesystem counters; it does not open/traverse/repair/resize the vhdx or shut down WSL.

If interop, registration, mount or identity is unavailable, show **Windows drive not identified / 尚未確認 Windows 磁碟** with **Choose drive / 選擇磁碟**. The owner can select a mounted local drive explicitly. Never guess the system drive or call WSL healthy from Linux root alone. Ambiguous/network mappings stay unavailable. Vhdx logical size is neither free nor reclaimable space, so it is outside the initial headline metrics.

## Sampling, bounds and low-water behaviour

Only while enabled: one sampler per computer; no probes per browser or request. Agent intervals below apply only when its separate sub-option is enabled.

- CPU and existing memory snapshot every 30s; filesystem counters every 60s, prioritising Fleet state and WSL backing drive; agent footprint every 60s.
- Reuse host-memory.ts, memory-pressure.ts and DarwinMemoryProbe without changing admission/spawn policy. The on-demand directory-size probes in resource-report.ts are **not** a periodic source.
- Ubuntu uses kernel counters. macOS caches container metadata and reuses its current pressure probe; an occasional bounded diskutil info on known volumes is acceptable, a filesystem/snapshot walk is not. Windows Runtime uses native counters rather than wildcard performance queries.
- Slow filesystem/interop/process reads stay off the Fleet request loop: one in-flight collection/provider, 2s deadline, 32KiB command discovery output and 512KiB process output. Linux kernel mount inventory has a separate 64KiB/512-record cap: the real S207 host inventory exceeded 32KiB; oversized or excessive records yield unavailable storage rather than silently losing a later overmount. Never spawn a replacement before the old worker physically exits. Timeout means unavailable data and a later sample, not a retry loop.
- Caps: 8 computers, 8 volumes each, 128 agent roots across Fleet, 4096 process rows/computer. Extra coverage is explicitly reported. Network mounts are opt-in and cannot delay local readings.
- Host raw history up to 24h; 5-minute rollups up to 30d. Agent 1-minute samples for 6h, 5-minute rollups for 7d. Up to 500 resolved alert events/30d; active incidents separately capped at 64.
- **64MiB total monitoring storage**, including journals/indexes/emergency state. Prune oldest history at 56MiB down to 48MiB; stop appending at the hard cap. Retention windows are maxima under this cap. Rollups preserve minimum disk availability, maximum CPU/pressure and coverage as well as averages.
- Below 2GiB available on the state volume **or verified WSL backing volume**, pause history writes and retain current snapshots in RAM. Resume after both exceed 4GiB for 10min. Minimal incident/delivery state has a preallocated bounded reserve inside the same budget. ENOSPC/read-only never crashes Fleet or starts repeated writes.
- Log transitions and bounded diagnostics, not every sample. Never automatically delete workspaces, compact disks or kill agents.

Handlers, Needs you and /sysinfo read the same cache. Refresh reloads that cache without launching probes. Return at most 240 chart buckets/series and 50 agent rows/page; do not allow a history reader to pin an unbounded journal. Enabled collection runs even with the web closed. Off runs nothing.

After two missed intervals, show **Stale / 資料已過期** and last-good time. Expected but unreadable metrics show **Not available / 無法取得** and a reason. Unknown is never zero or green; no-data gaps break lines. Unsuitable fields, such as APFS on Ubuntu, are omitted rather than treated as failures.

## Alerts

Current stopgap, reviewed without copying credentials/host identifiers: checks every 30min; Windows backing-drive free space below 60GiB warns, below 30GiB is urgent; WSL root usage at 85% warns. Warnings repeat after 6h, urgent alerts after 1h, recovery once. Successful delivery advances the sent timestamp; a failure does not. The worst overall level governs that script.

**Proposed product defaults for approval:**

| Rule | Warning | Urgent |
| --- | --- | --- |
| WSL backing drive | Below 60GiB for 2 samples | Below 30GiB at next valid sample |
| Relevant Linux/APFS filesystem | Used ≥85% for 2 samples | Used ≥95% for 2 samples |
| Memory | Existing elevated pressure for 2min | Existing critical pressure for 1min |
| CPU | ≥90% for 5min | ≥98% for 10min |

Compare byte counters, not rounded display values. Owners can edit thresholds per computer/volume, with ordering/capacity validation. Inode exhaustion uses 85/95% when available. Load and agent rankings provide context, not independent urgent triggers.

Track one durable incident per computer/resource/volume, rather than the stopgap's single worst level. Coalesce simultaneous chat changes into one host summary. Escalate when its hold period is met. Recovery uses hysteresis: backing free ≥65GiB, filesystem use ≤80%, CPU <80%, or existing memory state Normal; hold for 10min (2min memory, 5min CPU). De-escalation updates the item; one recovery message follows full clearance. Missing data never resolves an incident.

Keep 6h warning/1h urgent reminders measured from **successful delivery**, persisted across restart. One pending notification/incident with bounded delivery backoff. Acknowledge records who saw it without hiding/resolving the problem. Snooze is explicit and bounded; escalation bypasses warning snooze.

- **Needs you:** one live item with value, threshold, duration, sample age and View host health. Acknowledged problems remain visible.
- **General:** concise initial/escalation/reminder/recovery summaries to the existing owner/admin destination, with a web link. No broadcasts to every agent or new webhook discovery.
- **/sysinfo:** cached summary, incidents, coverage and sample age; no monitoring disk/process/model probes.
- **Settings → Notifications → Host health:** thresholds/destinations/snooze with existing administrator and confirmation rules. Detailed metrics and changes are administrator-only on supported listeners; no guest access.

Do not change cron/webhook during design. After implementation, the operator explicitly chooses notification handoff to avoid duplicate senders. A collector inside WSL cannot notify while WSL/the host is down; an independent Windows-side watchdog is a separate follow-up.

## Approval and later delivery

Approve/reject the off-by-default Settings control, separate agent option, overhead estimates, page, platform-specific views, defaults and bounded policy before implementation. First delivery must support **WSL, macOS and native Ubuntu**. Windows Runtime adds negotiated coverage and honest unknowns for older versions.

Later slices: collector/cache and bounded history; incident/delivery integration; Fleet UI. Validate parsers/missing states offline, storage caps/low-water deterministically, then native acceptance on each platform. Prototype captures prove layout only, not native collection or alert delivery.

A future rollback disables the sampler/notifications and removes bounded history while leaving Fleet work and the current stopgap untouched. This design implements none of those operations.
