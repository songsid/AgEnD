# Codex 0.167.2 → 0.169.0 audit

**Verdict: one detector change, no live misbehaviour.**
- **What changed:** in 0.169.0 the resume-loading screen (`  Resuming session…` over the composer) shows the bare shortcut
  hint `  ? for shortcuts` under the composer. AgEnD's resume-in-progress input guard (`codexUnboxedResumeLoading`)
  required the composer to be the last thing on screen, so it stopped firing.
- **Why nothing broke live:** the frame is also not ready, so nothing was delivered into it. The guard is the safety
  net for exactly this screen, so it is restored. One bare hint row is allowed under the composer; anything else still
  means a settled session, whose footer carries the status line's session id above its hints.
- **Everything else** reads the same on both versions.

## Method
- **Installs:** both versions went into scratch npm prefixes (`npm install --prefix … @openai/codex@X.Y.Z`), never the
  host's codex.
- **Capture runs:** `pass1.sh` + `pass2.sh` (`scripts/manual/codex-version-audit`) ran each version inside `unshare -rn`
  (loopback only).
  - Each run had a private tmux socket, scratch homes, and the mock Responses API on ports 18760 (0.167.2) and 18762
    (0.169.0).
  - Launches use the production `writeConfig` + `buildCommand`.
  - Every changed frame is captured at 25 ms.
- **Sign-in screens:** captured from an empty home, offline, in a private tmux server: the menu, then Down Down Enter
  into "Sign in another way".
- **Classification:** `classify.ts` ran the production predicates over every frame of both runs. The only reading that
  differed was the resume-loading frame. The other differences were timing (a frame caught one step earlier or later).
- **Sources:** compared from the `rust-v0.167.2` and `rust-v0.169.0` tarballs: `codex-rs/tui`, `exec`, `login`,
  `protocol`, `state`.
- **Not run:** the real-CLI e2e. codex's TUI bootstrap reads the account API, and the audit makes no real-account calls.
- **Normalisation:** one frame per surface; paths become `/tmp/codex-audit`, the port 18762, ids zeros, clock times 12:00.

## The precheck items
- **Literal counts** (`rate_limit` 114→46, `status_line` 24→4, `archived_sessions` 13→2, …): these are binary string
  counts. All 112 non-template detector literals are still in 0.169.0's source; most counts there went up (`rate_limit`
  1797→1834, `status_line` 1077→1124). The status-line items AgEnD writes (`session-id`, `context-remaining`) are
  unchanged, and so is the `archived_sessions` directory.
- **"Press R to retry", "press R to continue here", rate-limit reminders:** neighbour reorders. The strings exist in
  both versions.
- **0.168.0, 429 reconnect status (#59253):** a 429 stream retry now reads `Server is busy, reconnecting n/m` (was
  `Reconnecting... n/m`) and honours Retry-After. AgEnD reads neither text, and no codex error pattern matches the new
  row (checked). The app-server reconnect strings (`Reconnecting to server…`, `Reconnect failed — …`) are unchanged.
- **0.169.0, `codex exec` project trust (#60041):** exec still runs in an untrusted project.
  - It only disables project-local config (`.codex/config.toml`, and with it that file's MCP servers) unless `--trust`
    is passed, and prints a warning on stderr.
  - AgEnD runs `codex exec` only for Windows-native agents (`src/windows-cli-providers.ts`). It passes its MCP server
    as `-c mcp_servers.*` command-line overrides, not project config, so it is unaffected. `--skip-git-repo-check`
    still exists.
- **0.169.0, sign-in and custom gateways:** the new gateway and Bedrock-environment screens are additions.
  - The main menu and "Sign in another way" are byte-identical offline.
  - `codex login --device-auth` (`login/src/device_code_auth.rs`) is unchanged, and so is "Successfully logged in".

## Unchanged
- **State DB:** the migrations are identical (0062 is the newest), so rolling back stays safe.
- **Quota guard:** the protocol's `UsageLimitExceeded` / `task_complete` shape is unchanged.

## Frames
| Surface | Both versions → AgEnD |
|---|---|
| idle, near-limit (nudge suppressed), usage limit, workspace limits after Escape, capacity, model not found, resumed, a turn after resume, picker dismissed | ready, idle, deliverable, no dialog |
| slow turn | busy |
| resume loading | input held (`Codex session resume in progress`); 0.169.0 needed the change above |
| usage limit, workspace out of credits, workspace spend cap | the turn's row → quota/pause |
| trust | auto-trusted: Enter on the highlighted `Trust and continue` |
| rate-limit picker | Escape |
| sign-in menu | held for a human, no selection card |
| sign-in → another way | not ready, no dialog |
