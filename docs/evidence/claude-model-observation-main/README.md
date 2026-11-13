# Claude model observations — main PR #3812

AgEnD previously discarded the typed fallback notices and assistant model metadata. Statusline selection alone could therefore keep showing the selected model while another model served the response.

This is detection only: separate configured/launch/session/served values, typed safeguards/availability notices, one quiet Needs-you incident with recovery, localized runtime cards/details and Log, and compact `describe_instance` output (`detail:true` for bounded metadata). No automatic model, policy, restart or permission operation is added.

Source and capture pin: `29d3a5142` (full SHA in [checks.json](checks.json)). Main baseline: `3e4c2b657b86d343a5f70ab9d6f47e844fddeb46`. The evidence commit changes no product bytes.

## Verification

- **390/390, 17 focused files**, `vitest run --maxWorkers=2`; [command/results](checks/final-17-controls.log).
- Native TypeScript **7.0.2** source and test projects exit 0; changelog validation passes.
- **14 isolated reversals caught**, with native compilation and JS syntax checks where applicable; every source restored. [Cases, exact substitutions and digests](mutations/results.json), [runner](mutations/run.py).
- Fail-first: original monitor emits no observation ([baseline red](checks/baseline-monitor-red.log)); a response before monitor construction is lost ([early-record red](checks/early-record-before.log)); retained formatter loses localized detail ([retained-shell red](checks/retained-needs-before.log)); command-message prefix and three visual contracts each fail ([four semantic reds](checks/visual-prefix-before.log)). Final controls are green.
- **15 serial Chromium cases, 61 checkpoints, 53 PNGs**, with real cookie sign-in, product shell/SSE, Log reader/parser and styles. Every current phone Log pair is asserted to live in wrapping text and fit its box; zero page errors/CSP reports or horizontal overflow. Eight live recovery checks remove the incident without reloading. [Receipt and served-byte bindings](browser/receipt.json).

The browser uses synthetic typed metadata and the real pure observer, with a read-only projection seeded into an owned scratch FleetManager. It never starts a Fleet/CLI, types in a live pane, reads a live transcript or calls a vendor. Office cards open through the product's accessibility button. Scratch browser/listeners/home are closed. The earlier incomplete formatter run and pre-visual-fix gallery are private historical diagnostics, not accepted captures.

## PNGs

| Cases | Coverage |
| --- | --- |
| `after-*` (8) | Desktop/phone × light/dark × EN/zh-TW: Details, Needs you, Log, Office card; desktop also org list; live recovery |
| `before-desk-*-zh-TW` (2) | Exact baseline panel assets, no observation metadata; Details before state |
| `retained-shell-*` (2) | Fresh panels + baseline `app-i18n.js`, `app-needs.js`, `app.css`; Details/Needs/Log |
| `availability-*` (2) | Distinct availability cause; Details/Needs/Log |
| `retained-panels-*` (1) | Baseline Details/Needs/Log/Org/Office/Canvas modules on the current host; legacy readable pair fallback |

Representative final originals:

- [Desktop zh-TW Details](browser/after-desk-dark-zh-TW-details.png), [phone zh-TW Details](browser/after-phone-dark-zh-TW-details.png)
- [Desktop EN Needs you](browser/after-desk-light-en-needs.png), [retained-shell phone EN](browser/retained-shell-phone-light-en-needs.png)
- [Phone EN Log](browser/after-phone-light-en-log.png), [phone zh-TW Log](browser/after-phone-dark-zh-TW-log.png)
- [Desktop EN Office card](browser/after-desk-light-en-office-card.png), [phone zh-TW Office card](browser/after-phone-dark-zh-TW-office-card.png)
- [Availability zh-TW](browser/availability-desk-dark-zh-TW-details.png)

Final bounded visual recheck: 13 originals — four device/theme/language selections × Details/Log/Office, plus availability zh-TW Details — pass readability/localization/clipping checks. This is fixture presentation, not live CLI behavior. The first gallery's Needs-you visual check is historical; no new execution claim is made for it. All final PNGs remain available for parity review.

## Evidence and limits

The raw shapes are from Ridge's portable redacted Claude Code **2.1.323** producer investigation, binary SHA-256 `604d29a6869409106b6a1110bdadcc8b72e8654a5a865d23258f938a696e348e`, embedded build `66b1ade1dce6269a9b608cea1920135b24a97a66`. Historical samples span 2.1.226–2.1.316. Availability shape is producer-verified, not a claimed historical live occurrence. No vendor bundle or real prompts/answers/refusal explanations are included.

The inherited launch marker, session/main-path ownership, append/history boundary, generation checks and bounded checkpoint/dedupe fence old hooks and replay. Explicit child/meta/API-error/synthetic/refusal records are excluded; main-thread Haiku remains valid. Alias/default/opusplan values are not guessed. An unconfirmed `/model` marker is intent only. Opaque substitutions and otherwise-unmarked auxiliary rows cannot be distinguished from their metadata alone. A response observation is not an attestation of the final retained answer.

Retained-asset claims cover only the substitutions listed in each receipt. An entirely old already-loaded tab cannot gain the new presentation without loading current modules. Launches predating the marker become observable at their normal next restart; detection itself never restarts them.

Rollback removes the observer, optional projections and checkpoint. Saved model selections, failover policy, transcript bytes and runtime permissions are unaffected.
