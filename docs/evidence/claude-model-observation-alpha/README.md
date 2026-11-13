# Claude model observations — alpha PR #3815

Alpha twin of main #3812. Claude Code's typed fallback notices and served-model metadata were discarded while cards used only the session/statusline selection. This adds detection and presentation, with configured, actual launch, session and last-served facts kept separate. It never selects a model, changes policy/permissions or starts/restarts a CLI.

Source/capture: `34d236d2d98f10440c0819b20134aee47ee36f63`; alpha base `71dbc782956047c413b9f367a572e38c39d53651`. Product checks ran at `5a3dee7fb`; later commits change only the capture harness (settled waits, resumable load checkpoints and the phone Overview route). Full bindings are in [checks.json](checks.json) and [browser/receipt.json](browser/receipt.json).

## Alpha integration

The existing extracted Claude grammar, workspace-follow generations, fleet bridge, Log anchors/thinking/compact rows and all Hub/native reasons remain. Alpha's Log presentation lives in the shared `log-row.js`.

Native Claude metadata comes only from the existing runner-owned pinned transcript port. Each embedded session must match; baseline history stays silent. Exact source/session/port and native lifecycle ownership are rechecked when pending records drain, including partial batches and retirement during a context callback. There is no coordinator-local transcript or statusline fallback. Native session selection stays unresolved without statusline evidence; after a baseline/gap, served values remain observable while inferred mismatch detection is conservative. Typed fallback notices still prove their cause. Existing baseline, serialization, timeout and delivery-checkpoint bounds remain.

Local launches deliberately add `AGEND_CLAUDE_LAUNCH_ID=<UUID>` to their environment. The non-secret observational nonce is inherited by the CLI/statusline child; a late old hook executing a rewritten script still stamps its old owner. It grants no authority and selects no model/account/policy. Credential, memory and cache-TTL tests pin the marker and every remaining legacy command byte. The local startup tail recovers only current-launch metadata without replaying existing text/tools/usage alarms.

[Main/alpha parity](parity.json): ten identical blobs and nineteen identical patch sequences; nine explicitly adapted paths preserve alpha features. Five native/shared-row paths are alpha-only. No roles helper is activated and no Hub-guest room is implemented.

## Validation

- **469/469 across 23 focused suites**, maxWorkers=2; native TypeScript7.0.2 source/test projects exit0; changelog check passes. [Commands](checks/commands.txt), [results](checks/final-controls.log).
- **20 isolated compiling reversals caught/restored**: the main fifteen plus native session, ownership, lifecycle, gap and context-retirement fences. [Exact substitutions and digests](mutations/results.json). Initially the source-session reversal survived a monitor-only test because the independent monitor fence still refused it; a direct source-projection control now pins that boundary too.
- Native fail-first: [three semantic reds with baseline control](checks/runtime-before.log), plus [paired context retirement red](checks/runtime-context-before.log). Main redacted producer-shape, exclusion, alias, dedupe, recovery and launch-marker controls carry and run here too.
- **15 serial Chromium cases / 61 checkpoints / 53 PNGs**: EN/zh-TW, desktop/phone, light/dark, safeguards/availability, live recovery and bounded retained assets. Phone Details explicitly opens Settings → Overview. Log pairs wrap and fit; all cases report zero page/CSP errors and horizontal overflow.
- Bounded visual review of **15 originals**: four device/theme/language selections × Details/Log/Office, plus availability zh-TW Details and two retained-shell Needs-you originals. Model facts, pair, cause and scope are readable, with no material clipping/overlap. This does not claim every PNG was visually inspected.

The browser uses synthetic real-shaped metadata with the pure observer and an owned scratch FleetManager projection, real cookie sign-in, product shell/SSE, Log parser and styles. It starts no Fleet/CLI, calls no vendor, reads no live transcript, types in no live pane and operates no real native machine. Its first phone-index diagnostic is private historical evidence, not an accepted screenshot. The final gallery is complete; browser, scratch home and owned listeners are closed ([cleanup](cleanup.json)).

Representative originals: [desktop zh-TW](browser/after-desk-dark-zh-TW-details.png), [phone zh-TW](browser/after-phone-dark-zh-TW-details.png), [phone Log](browser/after-phone-light-en-log.png), [Office](browser/after-desk-light-en-office-card.png), [retained-shell Needs you](browser/retained-shell-phone-dark-zh-TW-needs.png).

## Limits and rollback

Producer basis is Ridge's portable redacted Claude Code2.1.323 handoff; historical shapes span2.1.226–2.1.316. Availability is producer-verified, not a claimed historical live occurrence. No prompts, answers, refusal explanations or vendor bundle are exported. Otherwise-unmarked auxiliary calls and opaque substitutions with unchanged metadata remain indistinguishable; Haiku is never a proxy for auxiliary work. An unresolved alias/picker intent suppresses mismatch inference while served values and typed notices continue. A served observation does not attest to the final retained answer.

Retained-asset claims cover only the exact listed substitutions, including alpha's old shared Log row. An entirely old already-loaded tab cannot gain new presentation without current modules. Pre-marker local launches become observable on their normal next restart; native baseline history is not replayed. Detection initiates neither restart nor policy/model action.

Leader resumed ordered alpha gating after the alpha.3 host upgrade. Fresh exact-head parity/CI and the coordinator gate remain required. Coordinator alone merges. Rollback removes optional observation readers/projections/checkpoint; configured selections, policies, transcripts and permissions remain intact.


## Checkpoint intent and startup read-budget repair (R1; historical)

The review found two shared problems: pending `/model` intent was missing from the checkpoint despite saved replay dedupe, and the metadata tail's explicit cursor still triggered an unbounded lookup from current EOF. The v2 checkpoint now records no intent, unresolved intent and concrete unconfirmed intent separately. Legacy v1 and invalid/missing intent restore conservatively as unresolved; a typed notice, a concrete owned confirmation or a new session can end that suppression. Served metadata remains visible.

The tail now verifies a complete record at or before its captured cursor. Boundary discovery and payload share the same physical byte budget; it never touches a later unfinished suffix. A boundary or record that does not fit is omitted, without emitting a partial record. The earlier inherited monitor baseline lookup and the separate whole-line recovery bound are unchanged.

Fail-first controls use private temp files and real file handles with byte counters, including a 16 MiB unfinished suffix, mid-record cursors, short reads and no-progress reads. Observer JSON round trips and actual daemon checkpoint files cover aliases, picker intent, concrete unconfirmed intent, quiet active incidents, confirmed/no-intent positives and legacy recovery. These changes add no UI, launch, native-source or lifecycle action. Existing harness, receipts and all 53 PNGs are unchanged; no new browser execution is claimed.

Repair verification at `d41ec09b63267a1a151aebc6e08d7d9d5255ee7d`: **499/499 across 26 suites**, both native type projects exit0, and all **26** isolated reversals have current baseline digests and exact restoration. Six new reversals pin intent serialization/restore/legacy handling and cursor/shared/boundary budgets. The paired fail-first run has16 semantic reds and6 controls. [Repair receipt](review-fixes.json), [checks](checks.json).


## Definite recovery and Log cursor repair (R2; historical)

The R1 fixes had two related gaps: conservative legacy intent could keep a quiet incident after definite recovery, and an exhausted generic tail boundary returned0 as a Log forward cursor, replaying old user/answer steps. A fresh original/configured-model response now clears that incident without confirming the missing command or enabling new mismatch inference.

The bounded reader is now startup-specific and exposes no forward cursor. The normal Log reader retains its original boundary lookup and exact shared payload scanner. Actual LogService initial→poll→append controls prove no old-step replay and later new-step delivery; real file-handle counters also prove the monitor uses the bounded startup lane, separately accounting for its inherited baseline lookup. The inherited earlier boundary scans remain unchanged.

At `30b071ed8489d012d658bda47c35c66667b705ca`, **556/556 across28 suites** and both native type projects pass. Six paired regressions are semantic-red on the exact prior head, with copied test sources/digests and exact restoration. Three new isolated compiling reversals pin pending recovery, the Log cursor and the monitor's startup lane; all **29** mutation baseline bindings are current. [Repair/source parity receipt](review-r2.json), [exact before recipe](checks/reproduce-r2-before.py), [checks](checks.json). Existing UI, native source, harness, receipt and all53 PNGs are unchanged. No new browser, vendor API, live transcript or pane operation is claimed.


## Alpha sync after #3809 (historical)

Plain merge `776cf10e2cc6ebf17d9a218f51cea6e2e10601b9` has parents `71eb2b5dfd16448293b9edccbdea2645edcb80fa` and `e77738fe12a021f6794776f5b5f1b2bc86a6509d`. The sole conflict was `log-steps.ts`: it retains #3809's exact ordinary bounded Log reader (including its interior EOF+skip cursor), Codex helpers/parser and the approved separate Claude metadata startup reader/payload scanner. The Claude parser is exact to the approved parent. The other two overlaps, the shared Log row and dashboard skill, auto-merge both sides. All45 incoming and195 own disjoint blobs are exact.

The old integration test expected the prior prefix cursor; that assertion is semantic-red with172 controls passing on the merged source. It now pins the incoming EOF+skip contract, while retaining no-write poll, no old history replay, and newly appended record delivery. **535/535 across21 focused suites**, both native source/test typechecks, and **three fresh isolated compiling reversals** pass their expected outcomes. A restored21/21 control follows exact source restoration. Prior29 mutation bindings and556/28 broad results remain historical R2 evidence; they are not relabelled as new-head runs.

[Sync receipt](review-sync.json) binds the source, parents, exact-reader comparisons, controls and three reversals. All53 original PNGs, the capture harness and receipt are unchanged. They remain the earlier bounded feature captures; no new merged-graph browser run or pixel comparison is claimed. No vendor, live transcript/pane, model, policy or lifecycle operation was performed.


## Static closure sync after #3816 and #3825

Plain merge `b338d410fc864decf11f203745ec196bb442b28e` has parents `fa63ee12601349d2ad14a36117ed78121f3a280f` and `67b5b2d7a521d39e351b676d4ca325aa40d77c3e`. Only `auth-api.ts` conflicts: against incoming alpha it adds only the existing public static `model-observation.js` leaf, while retaining `stale-tab.js` and its comment. The backend interface, daemon (including Grok proofs) and dashboard skill are byte-exact automatic three-way merges. All66 incoming and211 own disjoint blobs are exact at this source merge; Log readers/parsers and the earlier fixture repair are unchanged.

**278/278 across13 focused suites** and both native type projects pass. The actual anonymous static-closure test is semantic-red when either public leaf is independently removed; both reversals compile and restore exactly, followed by one selected restored closure control. Other tests in that selected run are not counted. [Sync receipt](review-sync2.json), [resolution](checks/sync2-resolution.json).

The earlier535/21 and three-reversal Log-resolution results retain their previous source scope and Prism clearance. All53 original PNGs, harness and capture receipt remain unchanged historical captures, with no new merged-graph browser or pixel-comparison claim. No vendor, live transcript/pane, native machine, model, policy or lifecycle action was performed. Fresh exact-head CI/Prism approval and the coordinator gate remain required.
