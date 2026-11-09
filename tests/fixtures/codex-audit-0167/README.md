# Codex 0.166.0 → 0.167.0 audit

**Verdict: one production change.** In 0.167.0, the folder-trust screen shown at startup offers `2. Back to Agent Command Center` with the footer `enter continue · esc back`. In 0.166.0 it was `2. Quit` / `esc quit`. AgEnD's auto-trust (#2893, the user's decision hmsg-53600a2c) accepted only the `Quit` layout, so on 0.167 every such prompt was held for a human instead of answered. Now the cancel option and its footer must come as one of the two known pairs; anything else is still held. Every other captured surface reads the same on both versions.

## Method (decision ffb8104e)
- **Installs:** both versions went into scratch npm prefixes, never the host's codex. Binary sha256:
  - 0.166.0: `b8a11fedf24b2dfb59a70c9e52b030f9a508dcd49cd2dd0d41956f4c785156b8` (the same as the 0.166 audit)
  - 0.167.0: `cdcb45aaa01d0f14e298985e09465aebccd47f64ecd298aea44814af7b62bbda`
- **Capture runs:** `pass1.sh` and `pass2.sh` from `scripts/manual/codex-version-audit` ran each version inside `unshare -rn` (loopback only). Each run had a private tmux socket, a scratch CODEX_HOME and AGEND_HOME, and the mock Responses API.
  - Launches use the production `writeConfig` and `buildCommand`.
  - Every changed frame is captured at 25 ms.
- **Sign-in screens:** captured from an empty home, offline. First the menu, then Down Down Enter into "Sign in another way".
- **Classification:** `classify.ts` ran the production predicates over every frame. The only reading that differed between versions was the trust prompt.
- **Sources:** compared from the `rust-v0.166.0` and `rust-v0.167.0` tarballs: `codex-rs/tui`, `codex-rs/state` migrations and `codex-rs/protocol`.
- **Not run:** the real-CLI e2e. As in the 0.166 audit, codex's TUI bootstrap reads the account API, and we make no real-account calls without the user's OK.
- **Normalisation:** one frame per surface; paths become `/tmp/codex-audit`, the port 18762, clock times 12:00.

## The precheck items
- **The missing literal "Provide your own API key", and "Sign in another way":**
  - The sign-in menu is now `1. Sign in with ChatGPT / 2. Sign in with Device Code / 3. Sign in another way`. The API key and Amazon Bedrock rows (and Google Cloud Vertex AI, with network) moved into that sub-menu.
  - The menu reads as before: it still contains "Sign in with ChatGPT", so it is held with no selection card (`signin-menu`).
  - The sub-menu activates no dialog and is not ready, exactly like 0.166's API-key screen (`signin-another-way`), so no card is offered.
  - **No change needed.**
  - Pre-existing, not new: `loginScreenPattern` (/Sign in with ChatGPT/) never recognised the sign-in sub-screens.
- **Vertex AI / ADC strings near resume literals:** they are the new Google Cloud onboarding wizard (`onboarding/gcp.rs`), not the resume screen. The production resume reads the same (`resume-loading`, `resumed`).
- **"Press R to refresh Analytics", "Press n to create one":** neighbour noise. Both strings exist in both versions.
- **Count changes** (`rate_limit` 121 → 114, `Switch to`, `status_line`, …): every captured surface reads the same. The rate-limit picker (`rate-picker`) and the usage, workspace and capacity rows classify as before.

## Quota guard (#3198/#3211)
- **What it reads:** persisted data, not the pane: `task_complete` records with `error.codex_error_info = usage_limit_exceeded` in the rollout, and the `threads` row (id, cwd, source, archived, rollout_path).
- **Checked live:** after the usage-limit turn, both versions write the same record shape: `event_msg` / `task_complete`, a string `turn_id`, `usage_limit_exceeded`, "You've hit your usage limit…".
- **Checked in source:** the state migrations are identical (0062 is the newest), and the protocol's `UsageLimitExceeded` is unchanged.

## Frames
| Surface | Both versions → AgEnD |
|---|---|
| idle, near-limit (nudge suppressed), usage limit, workspace limits after Escape, capacity, model not found, resumed, a turn after resume, picker dismissed | ready, idle, deliverable, no dialog |
| slow turn | busy |
| resume loading | input held (`Codex session resume in progress`) |
| usage limit, workspace out of credits, workspace spend cap | the turn's row → quota/pause |
| trust | auto-trusted: Enter on the highlighted `Trust and continue`. Before this change, 0.167 was held |
| sign-in menu | held for a human, no selection card |
| sign-in → another way | not ready, no dialog |

## Windows
Nothing Windows-specific is in this change. The trust prompt and the sign-in screens are the TUI's own. A native-Windows check under the forward-compat policy (decision cc3ce4fe) is still due.
