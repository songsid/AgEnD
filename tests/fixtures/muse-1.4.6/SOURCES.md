# muse 1.4.6 (1.4.6-R6000.1) — live captures, 2026-10-12

Captured from the real `muse-1.4.6-R6000.1` (sha256 prefix 82a495542965a5b6), fetched with
`check-cli-versions.sh --download` and run directly, never through the `muse` launcher. Each run was in a disposable
docker container with `--network none`, as a non-root user with a scratch HOME/XDG, on a private `tmux -L` server at
120x36. No account and no network were used. The `compare-1.4.4-*` captures come from `muse-1.4.4-R5419.1` (sha256
prefix cfc9d068441ff460, the binary audited in tests/fixtures/muse-1.4.4), run the same way.

Two providers were used:
- `echo`: muse's built-in offline provider, `--provider echo --disable-approval --trust-workspace`, as in 1.4.4.
- `meta` through a local stand-in: `META_API_KEY=<dummy> --provider meta --base-url http://127.0.0.1:18800`, served by a
  logging mock of the Responses-style `/responses` SSE API. It can reply with text, a `bash` tool call, or an HTTP 429.
  "prod" means AgEnD's production flags `--disable-approval --trust-workspace`. The `approval-*` captures leave approval
  on (AgEnD's `skip_permissions: false`).

The workspace `/home/u/work` is replaced by `/tmp/muse-audit/work`. The status bar's `~/work` is kept, and trailing
spaces are trimmed. Nothing else is edited.

| File | How |
|---|---|
| `first-run-trust-dialog` | no flags, first run |
| `offline-first-run` | `--trust-workspace`, logged out: the login menu |
| `echo-idle` / `echo-busy` / `echo-done` | echo, `--echo-delay-ms 3000`: after startup / while the reply is pending / after it |
| `echo-after-escape` | echo, delay 4000: the prompt pasted as AgEnD does (`paste-buffer -p`, then Enter), Escape 1 s later. The turn is removed and its text is back in the box. (Typed keys plus Enter in one tmux command leave an extra empty row on 1.4.4 and 1.4.6 alike.) |
| `echo-quit` / `echo-resumed` | `/quit`, then `resume <id>` of the printed session |
| `resume-missing` | `resume <unknown uuid>` |
| `meta-idle` / `meta-done` | meta via the mock, prod flags: status bar `model · effort · cwd · Launch overrides` |
| `prod-escalation-denied` | prod flags, the mock asks `bash` with `sandbox_permissions: require_escalated`: denied, no prompt |
| `prod-rate-limited` | prod flags, the mock answers HTTP 429: muse's retry line |
| `approval-escalated` (+`-after-esc`) | approval on: the escalated `bash` call's prompt, then Escape |
| `approval-untrusted-staged` (+`-after-1`) | `--approval-mode untrusted`: the new staged prompt (allow this stage once / always allow in this workspace / abort the entire command), then `1` |
| `prod-background-work`, `prod-quit-with-local-work` | prod flags plus `--disable-sandbox` (only so the command can run in the container): a backgrounded `sleep`, then `/quit` |
| `compare-*`, `compare-1.4.4-*` | the same sequences on 1.4.6 and on 1.4.4: the escalated approval prompt with approval on (`--trust-workspace`, no `--disable-approval`, the same `bash` + `require_escalated` call), and the background, `/quit` and Ctrl-C ×2 sequence |
