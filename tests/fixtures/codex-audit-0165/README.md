# Codex 0.164.0 → 0.165.0 audit

**Verdict: SAFE for every captured AgEnD integration surface; no production change.** The PR widens the two real-CLI e2e gates to 0.164/0.165 and adds these fixtures.

## Method
- Both versions were installed with npm into a scratch prefix (never the host's codex).
- The committed rig (`scripts/manual/codex-version-audit`, `pass1.sh` + `pass2.sh`) ran each version on its own private tmux socket, with scratch CODEX_HOME/AGEND_HOME, against the mock Responses API (no account).
  - It uses the production `CodexBackend.writeConfig` + `buildCommand`.
  - Every changed frame is captured at 25 ms.
- `classify.ts summary` gave the same production readings for both versions on every scenario.
- Here: one frame per surface, normalised (paths → `/tmp/codex-audit`, ports, UUIDs, clock times).
- The real-CLI e2e (`npm run test:codex-e2e`, `AGEND_CODEX_E2E=1`) passes on both: `codex-exact-cwd-resume-e2e` + `codex-status-line-e2e`, 7/7. This step uses the real login (symlinked), and no model turn is sent.

## Precheck items
- **hard** `rate limit reset credit detail request timed out; falling back to the usage response`: present in both sources, in `app-server/src/request_processors/account_processor/rate_limit_resets.rs`, byte-identical lines. It is not a new message, and no AgEnD detector reads it.
- **hinted** `Resume the task to continue, or retry the action.`: present in both, in `tui/src/app/agents_overview_actions.rs`. Only the binary's string order changed.
- **hinted** `rate limit exceeded; sleeping.`: not in codex's own source; it comes from a dependency.
- **Count changes** (`check_for_update_on_startup` 19→17, `status_line`, `rate_limit_exceeded`, `of your`): every non-test use in codex's source is identical between the tags. `tui/src/updates.rs` still skips the startup update check when `check_for_update_on_startup = false`, which is AgEnD's pin. The count changes come from other crates or dependencies.

## Release-note items checked
- **#56445: a provider's `model_not_found` is no longer retried.**
  - 0.164 retried, then showed `■ unexpected status 404 Not Found: The model … does not exist …, url: …`.
  - 0.165 shows the provider's message at once (`■ The model … does not exist or you do not have access to it.`).
  - No AgEnD pattern matches either form, so behaviour is unchanged. Not detecting a model-not-found turn is an existing gap, not a regression; see the `model-not-found` frames.
- **#56330 (queued agent messages respect interrupts):** this concerns codex's agent-message wakes. The TUI composer, queue, key hints, status line and status indicator (`chatwidget`, `bottom_pane`, `key_hint.rs`) are unchanged between the tags. Our interrupt and queued-input path reads the same; see the `busy` and `idle` frames.
- **#56163 (reasoning-effort overrides on by default):** the `reasoning_effort_override` feature flag moves to Stable/default-on, for changing effort mid-conversation. AgEnD's launch flag `-c model_reasoning_effort="<level>"` reads the same config key, which is unchanged.
- **#56211/#56414 (memory v2 default for fresh profiles, external-agent memory import):** no TUI startup screen or prompt changed (`should_show_onboarding` unchanged). The fresh-launch frames show no new dialog.
- **Resume/session lookup:** still `state_5.sqlite`. Migration 0062 only adds a nullable `threads.attached_thread_parent_id` and its index. `SessionMeta` only gains an optional `attached_thread`, and `cwd` is unchanged.
- **Startup screens:** the daemon-startup snapshots were renamed, not changed.

## Frames
| Surface | Both versions → AgEnD |
|---|---|
| idle, near-limit (nudge suppressed), resumed, a turn after resume, picker dismissed | ready, idle, deliverable, no dialog |
| slow turn | busy |
| resume loading | input held (`Codex session resume in progress`) |
| usage limit (429) | ready; the turn's row → quota/pause |
| capacity | ready; the row → model_error/nudge_continue |
| model not found | ready; the row → no pattern (see #56445 above) |
| folder trust | held, no keys |
| rate-limit picker | held; only Escape |
