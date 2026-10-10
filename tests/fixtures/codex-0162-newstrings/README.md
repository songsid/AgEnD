# Codex 0.162.x precheck follow-up

**Verdict: no interaction gap found for these three strings. Production code is unchanged.**

This follows #1573 and the conservative `MAJOR` result for 0.160.0 → 0.162.0 in
#1575 at `a7247d3f88863a01a1ad81fc776a71986b14197b`. Fable supplied the exact
candidate bytes, offsets and neighboring literals; see `precheck-exact.json`.
Proximity in a native string table does not establish a TUI call path.

## Trigger, reachability and current handling

| Candidate | Actual trigger and AgEnD reachability | Current handling / verdict |
|---|---|---|
| `continue this task…resolve the error above…different tier…` | A native Fast/service-tier selection updates the **current session first**, then `config/batchWrite` fails to save the default. It is not a model-failure, launch or resume modal. An AgEnD-launched or resumed session can encounter it later through native tier controls. | A history error plus an ordinary live composer. Both versions, fresh and resumed: **idle**, delivery gate `ready`, no transient/dialog/error action, no automatic keys. A subsequent mock turn completes without dismissing the message. Safe for the captured parse-failure case. |
| `rate limit reset credit detail request timed out…` | An internal app-server `tracing::warn!`, after the optional credit-detail request exceeds **5 s**. ChatGPT-authenticated startup prefetch, `/status`/usage and other non-periodic reads can call it; periodic reads exclude details. Usage and details run concurrently; successful usage survives a detail timeout. | **No TUI screen to classify.** The string alone matches no AgEnD error/dialog/ready/busy detector. Native RPC receipts return the original usage and credit count after the timeout. It already exists in 0.160.0; the precheck candidate includes a changed adjacent Rust string. Safe, not a new resume/error screen. |
| `resume this agent or retry its blocked work…` | Model-visible completion instruction for a **MultiAgentV2 child**, after strict Guardian circuit breaking produces `TurnAborted(Interrupted, TooManyDenials)`. Delivered to the parent as an `agent_message` with `trigger_turn: false`. Not a launch/resume dialog; possible later during a configured native child-agent task. | **Model context, not pane chrome.** Its `or retry` substring happens to contain the short resume-footer literal `r retry`. AgEnD has no automatic key/error action for this text. No new modal or special instance state is introduced by this instruction. Native Guardian execution was not rehearsed; the reachability statement is source evidence. |

Do not add broad `continue`, `resume` or `rate limit` pane matches for these
strings. The save failure is recoverable within the active task; the other two
are not actionable terminal dialogs. Such matches would also act on quoted prose.

### Pinned upstream sources

All nine source files in `source-carry.json` are byte-identical between the two
0.162 tags. Full tag commits and native binary hashes are in `manifest.json`.

- [Service-tier event: session selection precedes persistence; failure inserts a history cell](https://github.com/openai/codex/blob/rust-v0.162.0/codex-rs/tui/src/app/event_dispatch.rs#L2533-L2560).
  [Native tier controls](https://github.com/openai/codex/blob/rust-v0.162.0/codex-rs/tui/src/chatwidget/service_tiers.rs#L47-L66)
  dispatch [the override and persistence events](https://github.com/openai/codex/blob/rust-v0.162.0/codex-rs/tui/src/chatwidget/service_tiers.rs#L100-L116).
  [The older release already had the same save-error branch](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/tui/src/app/event_dispatch.rs#L2391-L2415);
  0.162 adds the explanatory sentence and formatted config diagnostics.
- [Credit-details timeout and `None` fallback](https://github.com/openai/codex/blob/rust-v0.162.0/codex-rs/app-server/src/request_processors/account_processor/rate_limit_resets.rs#L3-L32),
  [auth admission, parallel usage read and count-only fallback](https://github.com/openai/codex/blob/rust-v0.162.0/codex-rs/app-server/src/request_processors/account_processor.rs#L1190-L1265),
  [nonblocking startup prefetch](https://github.com/openai/codex/blob/rust-v0.162.0/codex-rs/tui/src/app/startup.rs#L1111-L1129),
  [periodic detail exclusion](https://github.com/openai/codex/blob/rust-v0.162.0/codex-rs/tui/src/app/background_requests.rs#L815-L828).
  [The identical log is in 0.160.0](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/app-server/src/request_processors/account_processor/rate_limit_resets.rs#L25-L31).
- [Guardian parent-message formatter](https://github.com/openai/codex/blob/rust-v0.162.0/codex-rs/core/src/session_prefix.rs#L14-L47),
  [V2 child / interrupted denial admission](https://github.com/openai/codex/blob/rust-v0.162.0/codex-rs/core/src/session/mod.rs#L2356-L2424),
  [parent delivery with no triggered turn](https://github.com/openai/codex/blob/rust-v0.162.0/codex-rs/core/src/agent/control/completion.rs#L92-L127).
  [Upstream test proves the message enters the parent's model request](https://github.com/openai/codex/blob/rust-v0.162.0/codex-rs/core/tests/suite/guardian_subagent_notification_tests.rs#L177-L232);
  that test was read, not run locally.

## Native evidence

The existing `scripts/manual/codex-version-audit` rig uses production
`CodexBackend.writeConfig`/`buildCommand`, with `mcpServers: {}`, private instance
homes and a loopback mock Responses provider. Binaries are the private npm-prefix
installs retained from #1573; no host/global installation changed.

For each version:

1. Launch with the rig, then supply a `model_catalog_json` containing one mock
   model with a Fast (`priority`) tier. The upstream bundled catalogue also has
   Fast tiers; the rig's custom mock model otherwise has none. The catalogue is
   a test input, not a production change or a captured vendor catalogue.
2. `/fast` succeeds (positive persistence control). After the live TUI starts,
   replace **only its private** `config.toml` with `[broken`, as in upstream's
   `model_defaults_tests.rs:146-147` rejected-write fixture.
3. `/fast` changes the live selection and emits the full new error sentence.
   Send a normal message with the invalid file still present: the mock returns
   `ok`, and the TUI returns to its ready composer.
4. Restore the private config, use the production exact-cwd resume plan, and
   repeat the failing save and successful next turn in that resumed session.

The fourteen `.pane.txt` files are the final native frames from these steps.
Only scratch paths and trailing viewport blank rows are normalized; a wrapped
scratch path may be joined during redaction. The upstream `.snap` file is an
unmodified **upstream rendering snapshot**, not another native capture.

Quota receipts use the real native **app-server stdio RPC** with synthetic
ChatGPT tokens and a loopback-only mock backend. No real account was used.
The mock answers usage immediately but holds credit details for seven seconds:

| Version | Detail timeout / successful usage reply | Periodic-style read, no detail fetch |
|---|---:|---:|
| 0.162.0 | 5005 ms | 13 ms |
| 0.162.1 | 5006 ms | 13 ms |

Both return `usedPercent: 21`, `availableCount: 3`, `credits: null`. The mocked
usage omits account identity and some permission fields; these receipts do not
claim account-readiness or Reserve authorization coverage. The exact WARN is in
the normalized `.log.txt` files. JSON receipts are unmodified, cumulative call
traces; the periodic call adds only `/usage`. These are RPC receipts, **not TUI
quota frames** or production latency measurements.

## Isolation and limits

- Scratch HOME, CODEX_HOME and AGEND_HOME; explicit clean environments without
  inherited bot/account tokens; own `coredump_filter=0`.
- Private sockets `cx01620-df7cd6` and `cx01621-df7cd6`: before/after session
  lists empty; during each run only its `mock` and `tier` sessions. No query was
  made against the default/live server. The manifest records those receipts.
- Native app-server probes owned their children and loopback servers. Children
  were interrupted and joined; synthetic auth files were removed.
- No fleet, adapter, real model turn, real-account access, live operator store,
  real quota reset, native Guardian task, macOS or Windows run.
- An initial exploratory `/fast` on the rig's uncatalogued mock model returned
  “Unrecognized command”. It is retained in scratch and excluded from the
  claimed tier-save captures. The actual tested command uses the catalogue.
- “Safe” is limited to these strings and captured conditions. A different
  config error could contain a separately matched API error, and this audit
  does not claim coverage of every possible error payload or Guardian outcome.

## Saved-frame checks

`tests/codex-0162-newstrings.test.ts` exercises the real backend predicates,
`PaneStateMachine`, daemon delivery gate and error evaluator with inert pane and
process boundaries. Every native frame must be idle and ready, with no injected
key/paste or error-recovery state. It also pins the completed next turn, native
RPC fallback and the non-chrome status of the two non-TUI strings. The suite
starts no native CLI, tmux or fleet.

```sh
node node_modules/vitest/vitest.mjs run tests/codex-0162-newstrings.test.ts
```

Author checks: focused four-file bundle **77/77**, zero skips; full test-project
typecheck and build/postbuild pass. Four both-version fixture reversals fail
with direct AssertionErrors: missing new instruction (2), missing completed
next turn (2), lost credit count (2), unknown footer (14). All fixture bytes
were restored before the final checks. These are fixture/assertion reversals,
not production changes or a replay of every native probe.

Rollback: remove this fixture directory and test. There is no production change
to roll back, and no detector fix is proposed.
