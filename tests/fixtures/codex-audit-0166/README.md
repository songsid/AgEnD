# Codex 0.165.0 → 0.166.0 audit

**Verdict: SAFE for every captured AgEnD integration surface; no production change.** This PR adds fixtures and a test,
plus the workspace-limit steps in the rig's `pass1.sh`. The real-CLI e2e gates are not widened, because the e2e was not
run (see below).

## Method
- Both versions were installed with npm into scratch prefixes (never the host's codex). Their binaries' sha256 match the
  upstream watch's tarballs:
  - 0.165.0: `c06a67fd8ac76508dc78bd99ce20c9f317b8d568beda59485f3f4134df9962d5`
  - 0.166.0: `b8a11fedf24b2dfb59a70c9e52b030f9a508dcd49cd2dd0d41956f4c785156b8`
- The committed rig (`scripts/manual/codex-version-audit`, `pass1.sh` + `pass2.sh`) ran each version inside
  `unshare -rn`, so there was no network beyond loopback. Each run had its own private tmux socket, scratch
  CODEX_HOME/AGEND_HOME, and the mock Responses API.
  - Launches use the production `CodexBackend.writeConfig` + `buildCommand`.
  - Every changed frame is captured at 25 ms.
- `classify.ts summary` gave the same production readings for both versions on every scenario. After normalising (paths,
  port, version, clock times), the final frame of every scenario is identical between the versions.
- Not run: the rig's `kill` step, which finds the app-server by reading `/proc/<pid>/environ`. AgEnD runs codex
  embedded, as the 0.165 audit noted.
- **The real-CLI e2e was NOT run.** Codex's TUI bootstrap reads the account API before the composer appears: offline it
  stops at `account/read failed during TUI bootstrap … workspace routing discovery timed out`, the same on 0.165.0 and
  0.166.0. We make no real-account calls without the user's OK, so the evidence is the offline captures here. The e2e gates
  stay at 0.165.
- Here: one frame per surface, normalised (paths → `/tmp/codex-audit`, port → 18762, clock times → 12:00).

## Precheck items
- **Count changes:**
  - `Ask Codex to do anything` 2 → 1: the composer is unchanged on screen. The copy that went sat beside
    `Resuming session…` / `Forking session…`. The resume still shows `Resuming session…` over the composer, read as the
    resume transient (`resume-loading`).
  - `Switch to` 12 → 15: the three new copies are permission-mode key-binding help (`Switch to the next/previous
    available permission mode`). The rate-limit picker's rows are unchanged (`rate-picker`).
  - `rate_limit`, `rate limit`, `rate_limit_exceeded`, `check_for_update_on_startup`, `status_line`,
    `Successfully logged in`: one or two more copies each. Every captured surface reads the same.
- **The two unhinted new strings are neighbour noise:**
  - `Press r to refresh⏎Shift+⏎newline…` and `Usage limit resets … Check availability`.
  - `Press r to refresh`, `Usage limit resets` and `Check availability` each occur once in both binaries.
- **The hinted strings have the same count in both binaries:**
  - `Usage limit reached` (2), `Your included usage is exhausted` (1), `Request a limit increase from your owner` (1).
  - The usage-limit row, the workspace-limit prompts and their Escape read identically (`usage`, `ws-*`).
  - `No, and tell Codex what to do differently`: the approval dialog is unchanged and held (`approval`).

## Release-note items checked
- **#57227 (approvals preserved on resume/fork):**
  - The test: an approval was left pending, the pane was killed, then `resume --last` ran.
  - Both versions resume to `Conversation interrupted` and the composer; the approval is not re-shown.
  - AgEnD's default launch bypasses approvals.
- **Resume-picker pagination, `codex queue --resume`:** AgEnD resumes by exact id (`resume <id>`), never through the
  picker. The production resume reads the same (`resume-loading`, `resumed`).
- **Reconnect recovery (#57820):** the app-server kill step was not run (see Method).
- **One new transient frame on 0.166:** right after the resume transient, a bare `› Ask Codex to do anything` is shown for
  about 40 ms before the history redraws (`01660/resume-redraw`). It reads not ready and not deliverable, so AgEnD waits
  through it.

## Found on the way (not a 0.166 change)
`skipPermissions: false` launched codex with `--full-auto`, which every supported codex refuses. That is fixed separately
in #2886 / PR #2887. The `approval` frames here were captured with that fix's flags,
`--sandbox workspace-write --ask-for-approval on-request`.

## Frames
| Surface | Both versions → AgEnD |
|---|---|
| idle, near-limit (nudge suppressed), usage limit, workspace limits after Escape, capacity, model not found, resumed, a turn after resume, picker dismissed | ready, idle, deliverable, no dialog |
| slow turn | busy |
| resume loading | input held (`Codex session resume in progress`) |
| resume redraw (0.166 only) | not ready, not deliverable |
| usage limit, workspace out of credits, workspace spend cap | the turn's row → quota/pause |
| workspace-limit prompt (#2847) | held; only Escape |
| capacity | the row → model_error/nudge_continue |
| folder trust, an approval | held, no keys |
| rate-limit picker | held; only Escape |
