# Claude model observations — main PR #3812

AgEnD previously discarded the typed fallback notices and assistant model metadata. Statusline selection alone could therefore keep showing the selected model while another model served the response.

This is detection only: separate configured/launch/session/served values, typed safeguards/availability notices, one quiet Needs-you incident with recovery, localized runtime cards/details and Log, and compact `describe_instance` output (`detail:true` for bounded metadata). No automatic model, policy, restart or permission operation is added.

Final source pin: `ad488fb11`; browser capture pin: `29d3a5142` (full SHAs in [checks.json](checks.json)). Main baseline: `3e4c2b657b86d343a5f70ab9d6f47e844fddeb46`. Later corrections isolate metadata startup recovery and accept a return to the configured model after launch failover. UI, FleetManager and capture harness are byte-identical to the capture. Its observer cases have configured = launch = original, where old/new recovery conditions agree. No later browser execution is claimed.

## Verification

- **390/390, 17 focused files**, `vitest run --maxWorkers=2`; [commands](checks/commands.txt), [results](checks/final-17-controls.log).
- **21/21 credential-profile controls**, preserving every legacy command byte after the pinned ownership marker.
- **138/138 startup isolation controls**, including a new [semantic red](checks/metadata-only-before.log) that caught unwanted text replay and its [fixed control](checks/metadata-only-controls.log).
- Native TypeScript **7.0.2** source and test projects exit 0; changelog validation passes.
- **15 isolated reversals caught**, with native compilation and JS syntax checks where applicable; every source restored. [Cases, exact substitutions and digests](mutations/results.json), [runner](mutations/run.py).
- Fail-first: original monitor emits no observation ([baseline red](checks/baseline-monitor-red.log)); a response before monitor construction is lost ([early-record red](checks/early-record-before.log)); retained formatter loses localized detail ([retained-shell red](checks/retained-needs-before.log)); command-message prefix and three visual contracts each fail ([four semantic reds](checks/visual-prefix-before.log)). Final controls are green.
- **15 serial Chromium cases, 61 checkpoints, 53 PNGs**, with real cookie sign-in, product shell/SSE, Log reader/parser and styles. Every current phone Log pair is asserted to live in wrapping text and fit its box; zero page errors/CSP reports or horizontal overflow. Eight live recovery checks remove the incident without reloading. [Receipt and served-byte bindings](browser/receipt.json).

The browser uses synthetic typed metadata and the real pure observer, with a read-only projection seeded into an owned scratch FleetManager. It never starts a Fleet/CLI, types in a live pane, reads a live transcript or calls a vendor. Office cards open through the product's accessibility button. Scratch browser/listeners/home are closed. The earlier incomplete formatter run and pre-visual-fix gallery are private historical diagnostics, not accepted captures.

## R1 parity pin

At R1, all product bytes remained identical to `f52c67b00`. The new concrete-intent test preserves the active incident and expected model when served metadata changes but the session hook does not; its matching-session positive clears it. The removed session predicate is assertion-red (M15). **207/207 across eight changed suites**, native test types exit0.

An unresolved `/model` alias/picker deliberately keeps mismatch inference unconfirmed until a concrete owned/confirmed selection, new session or typed fallback notice. It does not stop served-model observations or typed fallback notices. A served response alone cannot resolve the intended alias.

## R2 configured-return recovery

A self-found [semantic red](checks/configured-recovery-before.log) pins next-spawn failover (configured5.5 / launch4.8), then a typed provider fallback, then a served return to configured5.5. The incident now retires on that return as well as the original model. **208/208 across eight changed suites**, both native types exit0; all15 isolated reversals refreshed and caught/restored against this source. No model/policy/lifecycle write. UI/harness/PNGs are unchanged.

## R3 launch contracts and concepts mirror

**847/847 across all49 `claude-*` suites plus concepts sync (50 files)**, native test types exit0. The new `AGEND_CLAUDE_LAUNCH_ID=<UUID>` is an intentional, non-secret observational environment marker inherited by the CLI/statusline child. It grants no authority and selects no model/account/policy. Credential, cache TTL and memory fixtures pin that marker and preserve all remaining legacy command bytes. The marker prevents a late old hook from claiming the next launch after its script is rewritten. `docs/concepts.md` now mirrors the builtin skill exactly. Functional source is unchanged from R2; the backend comment and design explain the marker contract.

## R4 main sync

Plain merge of main `6148c52f` (#3814) into `f773dc990`, parents recorded in [sync receipt](sync-main3814.json). Only daemon import lines conflicted; both Claude observer and Grok proof imports remain. The Grok checkpoint, deliverySessionId and idle-submit consumed watch auto-merge intact. All disjoint incoming blobs match main; only daemon and backend types overlap. **888/888 across all Claude suites, concepts and Grok (51 files)**; both native types exit0. M8 owner-fence reversal refreshed/caught/restored; all15 mutation baseline bindings match the merged source. UI/observer/FleetManager/harness/PNGs are unchanged, with no new browser claim.

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


## Checkpoint intent and startup read-budget repair (R1; historical)

The review found two shared problems: pending `/model` intent was missing from the checkpoint despite saved replay dedupe, and the metadata tail's explicit cursor still triggered an unbounded lookup from current EOF. The v2 checkpoint now records no intent, unresolved intent and concrete unconfirmed intent separately. Legacy v1 and invalid/missing intent restore conservatively as unresolved; a typed notice, a concrete owned confirmation or a new session can end that suppression. Served metadata remains visible.

The tail now verifies a complete record at or before its captured cursor. Boundary discovery and payload share the same physical byte budget; it never touches a later unfinished suffix. A boundary or record that does not fit is omitted, without emitting a partial record. The earlier inherited monitor baseline lookup and the separate whole-line recovery bound are unchanged.

Fail-first controls use private temp files and real file handles with byte counters, including a 16 MiB unfinished suffix, mid-record cursors, short reads and no-progress reads. Observer JSON round trips and actual daemon checkpoint files cover aliases, picker intent, concrete unconfirmed intent, quiet active incidents, confirmed/no-intent positives and legacy recovery. These changes add no UI, launch, native-source or lifecycle action. Existing harness, receipts and all 53 PNGs are unchanged; no new browser execution is claimed.

Repair verification at `951b510c3e4009fa2cf654f7d46ac77fd34f5091`: **906/906 across 52 suites**, both native type projects exit0, and all **21** isolated reversals have current baseline digests and exact restoration. Six new reversals pin intent serialization/restore/legacy handling and cursor/shared/boundary budgets. The paired fail-first run has16 semantic reds and5 controls. [Repair receipt](review-fixes.json), [checks](checks.json).


## Definite recovery and Log cursor repair (R2)

The R1 fixes had two related gaps: conservative legacy intent could keep a quiet incident after definite recovery, and an exhausted generic tail boundary returned0 as a Log forward cursor, replaying old user/answer steps. A fresh original/configured-model response now clears that incident without confirming the missing command or enabling new mismatch inference.

The bounded reader is now startup-specific and exposes no forward cursor. The normal Log reader retains its original boundary lookup and exact shared payload scanner. Actual LogService initial→poll→append controls prove no old-step replay and later new-step delivery; real file-handle counters also prove the monitor uses the bounded startup lane, separately accounting for its inherited baseline lookup. The inherited earlier boundary scans remain unchanged.

At `90c41b38b4a46325fbcdf07f38a0b98275a4ec1e`, **1042/1042 across57 suites** and both native type projects pass. Six paired regressions are semantic-red on the exact prior head, with copied test sources/digests and exact restoration. Three new isolated compiling reversals pin pending recovery, the Log cursor and the monitor's startup lane; all **24** mutation baseline bindings are current. [Repair/source parity receipt](review-r2.json), [exact before recipe](checks/reproduce-r2-before.py), [checks](checks.json). Existing UI, native source, harness, receipt and all53 PNGs are unchanged. No new browser, vendor API, live transcript or pane operation is claimed.
