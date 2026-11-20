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

All10 originals are visually inspected for public safety and readability. General and agent names are synthetic. The drive letter is an example. No company details, credentials, real computer paths or chat identifiers are used.

## Limits and approval

This demonstrates proposed content/layout and unknown states inside the real app shell. The prototype controls are inert. It does not prove native detection, CPU attribution, APFS accounting, low-water behavior, persistence, alert delivery, contrast across arbitrary custom themes, or keyboard navigation. Those require implementation tests and native acceptance after user approval.

The current stopgap and its webhook remain untouched. Its private configuration is not copied into this evidence. See [the design note](../../design/host-monitoring-dashboard.md) for bounds, defaults and rollback.
