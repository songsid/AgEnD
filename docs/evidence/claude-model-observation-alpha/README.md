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

Alpha merges remain held for the alpha.3 rehearsal until Leader clearance. Coordinator alone merges. Rollback removes optional observation readers/projections/checkpoint; configured selections, policies, transcripts and permissions remain intact.
