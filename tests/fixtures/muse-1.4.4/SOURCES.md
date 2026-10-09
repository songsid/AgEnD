# muse 1.4.4 (1.4.4-R5419.1) — live captures, 2026-10-09

Captured from the real `muse-bin-1.4.4-R5419.1` (sha256 prefix cfc9d068441ff460), run directly — never through the
`muse` launcher, which updates the host — under `env -i` with a scratch HOME/XDG dirs, on a private tmux socket at
120x36, offline. Every capture except the logged-out screens uses the built-in `--provider echo` (no account, no
network). The scratch workspace path is replaced by `/tmp/muse-audit/work` (the status bar's abbreviated form by
`/t/muse-audit/work`); trailing spaces are trimmed; nothing else is edited.

| File | How |
|---|---|
| `first-run-trust-dialog` | `muse-bin` with no flags, first run: the workspace-trust dialog comes first |
| `offline-first-run` | `muse-bin --trust-workspace`, logged out: the login menu |
| `echo-idle` | `--provider echo --disable-approval --trust-workspace`, after startup |
| `echo-busy` | the same, sampled every 50 ms after submitting a prompt: the working line |
| `echo-done` | the same, after the echo reply |
| `echo-after-escape` | Enter then Escape in one tmux command: the turn removed, its text back in the input box |
| `echo-resumed` | `resume <id>` of the session the `/quit` above printed |
| `resume-missing` | `resume <unknown uuid>` in `sh -c '…; echo EXITED=$?'`: the message, exit 1 |
