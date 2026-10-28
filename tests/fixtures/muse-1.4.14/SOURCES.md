# Muse 1.4.14-R7309.1 — offline captures, 2026-10-28

The real binary, fetched by the daily upstream watch (which executes nothing) and run directly. The `muse` launcher was
never used, the host's installed muse (1.4.13) was never touched, and no live AgEnD pane was involved.

| Version | SHA256 | Bytes |
|---|---|---|
| 1.4.14-R7309.1 | `0809aac7cb58d18f5022b6d05e02aa1974683c0ec430e5f04d25b60ed17de2da` | 414927192 |
| 1.4.13-R6996.1 (the committed `muse-1.4.13` set, not re-captured) | `51e97f8de0aa175080e6576cbc055510a95dfe0ededf175c7f6b34fc8e3bf524` | 400902488 |

## Rig

- One disposable container, `docker run --network none --memory 2g --cpus 2 --pids-limit 256`, image node 22 + tmux +
  python3, unprivileged user `u`, a private socket `tmux -L audit` at 120×36.
- A fresh HOME per scenario (`/home/u/h-<scenario>`), workspace `/home/u/work`. The status bar therefore shows
  `/home/u/work` where the 1.4.13 set (HOME=/home/u) shows `~/work`.
- Environment: `env -i HOME=<scratch> XDG_CONFIG_HOME=<scratch>/.config PATH=/usr/local/bin:/usr/bin:/bin
  TERM=xterm-256color LANG=C.UTF-8 MUSE_UPDATE_INTERVAL_SECONDS=31536000`, plus `META_API_KEY=dummy-key` (not a
  credential) for the Meta mock.
- Flags: AgEnD's production launch `--disable-approval --trust-workspace`, plus `--provider meta --base-url
  http://127.0.0.1:18800 --model mock-model` for the logging Responses mock
  ([mock.py](../../../scripts/manual/muse-version-audit/mock.py), its control paths moved to `/home/u/audit`).
- Input as AgEnD sends it: `set-buffer`, `paste-buffer -p`, a 0.3 s settle, then Enter.
- The whole run is [capture.sh](../../../scripts/manual/muse-version-audit/capture.sh).

## Captures

| Capture | Procedure |
|---|---|
| echo-idle / echo-busy / echo-done | `--provider echo --echo-delay-ms 3000`; paste `hello echo` |
| echo-after-escape | paste `cancel me`, Escape after 1 s (same session, so `hello echo` is above it) |
| echo-quit / echo-resumed | C-u, `/quit`, then `resume <id>` |
| resume-missing | `resume 01a00000-0000-7000-8000-000000000000` |
| first-run-trust-dialog | Meta mock, no `--disable-approval --trust-workspace` |
| logged-out | `--trust-workspace` only, no key and no provider flag |
| meta-idle / meta-done | mock mode `text`; paste `say something` |
| prod-escalation-denied | mock mode `tool`, args `{"command":"echo hi","sandbox_permissions":"require_escalated",…}`, production flags |
| approval-escalated (+ -after-esc) | the same with `--trust-workspace` only; Escape |
| approval-untrusted-staged (+ -after-1) | `--trust-workspace --approval-mode untrusted`, args `{"command":"ls -la"}`; `1` |
| prod-rate-limited | mock mode `429` |
| prod-usage-limit | mock mode `402` (`{"error":{"message":"Usage limit reached","type":"usage_limit_reached"}}`) |
| orphan-stream-* | mock mode `slow`; paste `please do the long thing`, wait 6 s (`-inflight`), `pkill -9` the binary, `resume <id>` with the production flags (`-resumed`), paste `carry on` (`-after-turn`), `/quit` (`-quit`) |
| orphan-tool-* | the same with mock mode `tool`, args `{"command":"sleep 300"}`, plus `--disable-sandbox` (the container has no usable OS sandbox) |
| orphan-bg-* | the same tool with `"yield_time_ms":1000` (backgrounded) |
| orphan-*-session.jsonl | the session's first `route_facts` line plus every line naming `orphaned_by_process_loss`, verbatim |

The 1.4.13 HUP variant (`orphan-tool-hup-resumed`, which needs an `--init` container) was not repeated: SIGKILL already
covers the resume path, and the HUP case only showed a container artifact.

## Comparison with the committed 1.4.13 set

After normalizing session ids, the version, timestamps, the elapsed-seconds counter, `~/work` → `/home/u/work` and the
cycling working glyph (◇ ◆ ◈), these panes are identical to 1.4.13: echo-idle, echo-busy, echo-done, echo-resumed,
first-run-trust-dialog, logged-out, meta-idle, meta-done, all orphan-stream/-tool/-bg inflight, resumed and after-turn
frames.

The rest differ only in rig input or timing, never in muse's own text or layout:

- the pasted prompt (`do it` here, `please run the command` / `hit the rate limit` / `hello there` there);
- `echo-after-escape` shows the earlier `hello echo` turn above it;
- the 429 retry counter (`retrying in 2s · attempt 5/10` vs `1s · 4/10`);
- the shell's `EXITED=0` / `$` lines after `/quit`.
