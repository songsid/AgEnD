# M-3441 host-health design prototypes

Design only. No product collector, endpoint, persistence or notification sender is implemented. All readings, incidents, platforms and agent names are synthetic. Approval is for the proposed design; these are not native platform acceptance results.

## Capture recipe and scope

The repository's scratch FleetManager fixture served the actual Fleet app shell with only General. An inert prototype was mounted inside the main panel using the existing tokens, card/button/status primitives and PageHead markup. A temporary same-origin stylesheet and synthetic snapshots were injected by the browser harness. The harness and stylesheet stay in private artifacts; no application source, routes, settings, cron or host probes changed.

Headless Chromium, serial contexts: desktop 1366×900 EN light; phone 390×844 zh-TW dark for each required platform. Missing-data phone views use light mode. The fixture closes the browser, server and scratch resources in finally. A layout correction moved meters to consistent full-width tracks; only the final originals below are retained.

All nine primary contexts passed: exactly one prototype stylesheet request, delivered SHA matching the input, computed binding marker, matching platform/state, no page/prototype horizontal overflow, and all56 button/select targets ≥44px. The tenth view scrolls to the WSL agent cards. checks.json records these bounded assertions; its stylesheet digest identifies a private prototype input, not product CSS.

## Original views

| Platform/state | Desktop | Phone |
| --- | --- | --- |
| WSL: Windows backing drive urgent, Linux root separate | [EN](desk-en-wsl.png) | [zh-TW](phone-zh-wsl.png) |
| macOS: APFS shared-container warning, native memory pressure | [EN](desk-en-mac.png) | [zh-TW](phone-zh-mac.png) |
| Ubuntu: healthy native Linux | [EN](desk-en-ubuntu.png) | [zh-TW](phone-zh-ubuntu.png) |
| WSL backing drive not identified | — | [Choose drive](phone-zh-wsl-unknown.png) |
| macOS pressure unavailable, last-good time retained | — | [Unavailable](phone-zh-mac-unknown.png) |
| Older Windows Runtime lacks telemetry; no zero metrics | — | [Unavailable](phone-zh-windows-old.png) |
| Agent footprint and caveats, lower scroll | — | [Agent cards](phone-zh-wsl-agents.png) |

All10 original dashboard views are visually inspected for public safety and readability. General and agent names are synthetic. The drive letter is an example. No company details, credentials, real computer paths or chat identifiers are used.

## Limits and approval

This demonstrates proposed content/layout and unknown states inside the real app shell. The prototype controls are inert. It does not prove native detection, CPU attribution, APFS accounting, low-water behavior, persistence, alert delivery, contrast across arbitrary custom themes, or keyboard navigation. Those require implementation tests and native acceptance after user approval.

The current stopgap and its webhook remain untouched. Its private configuration is not copied into this evidence. See [the design note](../../design/host-monitoring-dashboard.md) for bounds, defaults and rollback.

## User revision: optional monitoring (R2)

Monitoring is explicitly false by default; no collector, monitoring timers, history file or notifications while off. The separate agent-footprint option is also false by default. Earlier dashboard originals above depict the consciously enabled state (including agent sampling), not installation defaults.

| Revised Settings prototype | Desktop EN | Phone zh-TW |
| --- | --- | --- |
| Parent off; agent option disabled and off | [Off](settings-desk-en-off.png) | [Off](settings-phone-zh-off.png) |
| Host monitoring on; optional agent sampling stays off | [On](settings-desk-en-on.png) | [On](settings-phone-zh-on.png) |

The four new views replace only the Notifications section body in the actual Settings page. They preserve its real header/nav, use the shared card/field/switch markup and tokens, and add no product setting. One temporary stylesheet response was verified per context; state, subordinate disabled state, no horizontal overflow and both switch labels at least44px were asserted. All four originals are individually inspected; prior ten views were not recampaigned. The controls are inert and never enable a collector.

### Cost proxy and estimate boundaries

`overhead-proxy.json` contains only bounded timings, counts and byte totals, without PIDs, paths, hostnames or process content. A one-shot private Node probe on this 6-logical-CPU WSL host read CPU/RAM/pressure plus root/backing-volume counters ten times; five process snapshots read each numeric proc stat row, capped at4096. No CLI/model, subprocess, sleep loop, history store, command line, environment or user-state walk. Final warmed-cache process count was368; 109522bytes read per table. Host meanCPU0.120ms/max0.232ms; process-table meanCPU4.592ms/max5.271ms. A first exploratory execution preceded addition of the successful-volume count; only the final explicitly bounded two-volume result is retained. This is a syscall/read proxy, not an implemented native collector or cold-cache guarantee.

Projection: conservatively charge the combined host read (including disk counters planned at60s) at30s: mean CPUms ×120 host reads/hour or ×60 process reads/hour; divide by36000 for percent of one core, then by6 for total-host percentage. Only read cost is measured. Incremental RAM2–4MiB host +2–8MiB agent and writes1–4MiB/hour each are planning estimates for2volumes/32agents, including a conservative allowance for page/WAL amplification, not measured physical writes or guarantees. The note lists omitted aggregation/helper/IPC costs and later one-hour platform validation. No persistent monitoring was enabled on this host.

The draft remains HOLD for user approval of the revised opt-in semantics, Settings switch, separate agent option and overhead estimates. No implementation, reviewer gate or merge request follows from these captures.
