# Muse 1.4.12-R6909.1 — isolated captures, 2026-10-23

Real binary, copied into a private prefix and executed directly (never the installed
`muse` launcher, never a live AgEnD pane):

| Version | SHA256 |
|---|---|
| 1.4.12-R6909.1 | `81e8bb16289203ba8e0ca7f80c4b82e59ba35f5ee50aafef93a2a4116f2cb27f` |

Host file: `/home/han/.local/bin/muse-bin-1.4.12-R6909.1` (399018328 bytes), copied to
`/tmp/muse-1412-audit/bin/muse`. Private `HOME`/`XDG_*`, private tmux socket
`/tmp/muse-1412-audit/tmux.sock`, 120×36. `env` with `TERM=xterm-256color`,
`LANG=C.UTF-8`, `MUSE_UPDATE_INTERVAL_SECONDS=31536000`. No AgEnD fleet/daemon
handler, host tmux session, installed CLI, credentials or vendor endpoint was used.

The logging [Meta mock](../../../scripts/manual/muse-version-audit/mock.py) bound
127.0.0.1:18800. Catalog `{"data":[{"id":"mock-model"}]}`. `META_API_KEY=dummy-audit-only`
is not a credential.

Paste on the isolated socket only: `tmux -S <socket> set-buffer -- <text>`,
`paste-buffer -p`, separate Enter after a short settle.

Only normalization: `/tmp/muse-1412-audit/work` → `/tmp/muse-audit/work`. Blank rows
and CLI text are retained.

`--disable-sandbox` is used because this host has no usable bwrap; it is not a
sandbox-success claim.

| Capture | Procedure |
|---|---|
| echo-idle | `--provider echo --disable-approval --trust-workspace --disable-sandbox --echo-delay-ms 1500`; ready empty composer. `echo-idle.ansi.txt` is `capture-pane -e` of the same frame. |
| echo-draft | paste `a real user draft` without Enter |
| echo-done | Enter on that draft; capture after `echo:` reply |
| meta-done | `--provider meta --base-url http://127.0.0.1:18800 --model mock-model --disable-approval --trust-workspace --disable-sandbox`; paste `say hi`; mock reply `mock reply ok` |
| first-run-trust-dialog | second isolated session, fresh HOME, no `--trust-workspace` |

## Placeholder frames (reconstructed)

Isolated echo and Meta-mock idle never painted the 1.4.12 empty-composer hint
(`TBH_TMUX_PROMPT_HINT_QUIET_OFFSET_SECS=0` and `TBH_IS_E2E_TEST=1` did not force it
either). The hint catalog is in the binary at offset 8596268, starting
`file-mentionsType @ to search and insert workspace file paths`. Live fleet
instances paint that string grey in an empty composer.

`echo-placeholder.pane.txt` is the live `echo-idle` frame with that exact string
inserted after `❯ `. `echo-placeholder.ansi.txt` is the live `-e` idle frame with
the same string in SGR 2 after `❯ `. `echo-placeholder-prefix.pane.txt` and
`echo-placeholder-extra.pane.txt` are the same idle frame with a prefix of the
hint, and the hint plus extra characters, as typed-text controls.

Other rotating catalog strings extracted from the same blob (exact match only):

- `Start a message with ! to run a shell command yourself`
- `Paste an image with Ctrl+V — file paths and URLs work too`
- `Press Alt+V to dictate instead of typing`
- `Tab queues or steers while a run is active`
- `Press ? on an empty composer to see keyboard shortcuts`
- `Press Ctrl+O to expand collapsed tool output`
