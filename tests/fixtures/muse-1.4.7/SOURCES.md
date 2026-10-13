# muse 1.4.7 (1.4.7-R6101.1) — live captures, 2026-10-13

Captured from the real `muse-1.4.7-R6101.1` (sha256 prefix 36e3dac91f56c155), fetched with
`check-cli-versions.sh --download` and run directly, never through the `muse` launcher. Each run was in a disposable
docker container with `--network none`, as a non-root user with a scratch HOME, on a private `tmux -L` server at
120x36. No account and no network were used. The `compare-1.4.6-*` captures come from `muse-1.4.6-R6000.1` (sha256
prefix 82a495542965a5b6, the binary audited in tests/fixtures/muse-1.4.6), run the same way in the same session.

Two providers were used:
- `echo`: muse's built-in offline provider, `--provider echo --disable-approval --trust-workspace`, as before.
- `meta` through a local stand-in: `META_API_KEY=<dummy> --provider meta --base-url http://127.0.0.1:18800`, served by a
  logging mock of the Responses-style `/responses` SSE API. It can reply with text, a `muse.bash` tool call, or an HTTP
  error. muse asks `/muse-code/models` for its model catalog at startup and stops when that fails (1.4.6 as well); the
  scratch HOME was seeded instead with a one-model catalog cache (`mock-model`) in muse's own cache format, so the mock
  serves no catalog. "prod" means AgEnD's production flags `--disable-approval --trust-workspace`. The `approval-*`
  captures leave approval on (AgEnD's `skip_permissions: false`).

The workspace `/home/u/work` is replaced by `/tmp/muse-audit/work`. The status bar's `~/work` is kept, trailing spaces
are trimmed, and tmux's own `Pane is dead (…)` row under an exited command is dropped. Nothing else is edited.

| File | How |
|---|---|
| `first-run-trust-dialog` | no flags, first run (fresh HOME) |
| `offline-first-run` | `--trust-workspace`, logged out (fresh HOME): the login menu |
| `echo-idle` / `echo-busy` / `echo-done` | echo, `--echo-delay-ms 3000`: after startup / while the reply is pending / after it |
| `echo-after-escape` | echo, delay 4000: the prompt pasted as AgEnD does (`paste-buffer -p`, then Enter), Escape 1 s later |
| `echo-quit` / `echo-resumed` | `/quit` (the command runs as `muse …; echo EXITED=$?`), then `resume <id>` of the printed session |
| `resume-missing` | `resume <unknown uuid>`, captured with 50 rows of history as the daemon reads it |
| `meta-idle` / `meta-done` | meta via the mock, prod flags |
| `prod-escalation-denied` | prod flags, the mock asks `bash` with `sandbox_permissions: require_escalated`: denied, no prompt |
| `prod-rate-limited` | prod flags, the mock answers HTTP 429: muse's retry line |
| `approval-escalated` (+`-after-esc`, `-cursor-2`) | approval on: the escalated `bash` call's prompt; then Escape; or Down once |
| `approval-untrusted-staged` (+`-after-1`, `-cursor-2`, `-cursor-3`) | `--approval-mode untrusted`: the staged prompt; then `1`; or Down once / twice |
| `prod-background-work`, `prod-quit-with-local-work` (+`prod-quit-after-esc`, `quit-menu-cursor-2`), `quit-dialog-ctrl-c-2` | prod flags plus `--disable-sandbox` (only so the command can run in the container): a backgrounded `sleep 300`; `/quit`; then Escape, or Down once; then Ctrl-C twice |
| `inflight-resumed` | prod flags plus `--disable-sandbox`: a foreground `sleep 120` tool call, muse killed with SIGKILL while it runs, then `resume <id>` |
| `goal-usage-limited-resumed` | echo: `/goal <objective>`, muse stopped, the goal's row in the session's `goals.db` set to `usage_limited` (the state muse gives a goal held by a usage limit; no offline route reaches it), then `resume <id>` |
| `model-picker` | meta via the mock, prod flags: `/model` |
| `compare-1.4.6-*` | the same sequences on 1.4.6 |
