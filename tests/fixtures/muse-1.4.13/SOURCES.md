# Muse 1.4.13-R6996.1 — offline captures with 1.4.12-R6909.1 controls, 2026-10-25

Real binaries, fetched with `check-cli-versions.sh --download` (which executes nothing) and run directly. The
`muse` launcher was never used, the host's installed muse was never touched, and no live AgEnD pane was involved.

| Version | SHA256 | Bytes |
|---|---|---|
| 1.4.13-R6996.1 | `51e97f8de0aa175080e6576cbc055510a95dfe0ededf175c7f6b34fc8e3bf524` | 400902488 |
| 1.4.12-R6909.1 | `81e8bb16289203ba8e0ca7f80c4b82e59ba35f5ee50aafef93a2a4116f2cb27f` | 399018328 |

## Rig

- **Containers:** two disposable containers, both `docker run --network none` (loopback only), with an unprivileged user `u` (`HOME=/home/u`) and a private socket `tmux -L audit` at 120×36.
  - The first has `sleep infinity` as PID 1.
  - The second adds `--init`, a real reaper. It is used only for `*-orphan-tool-hup-resumed`; see the trap below.
- **Environment:** `env -i HOME=/home/u PATH=/usr/bin:/bin TERM=xterm-256color XDG_CONFIG_HOME=/home/u/agend-xdg MUSE_UPDATE_INTERVAL_SECONDS=31536000 META_API_KEY=dummy-key`. The key is not a credential.
- **Flags:** AgEnD's production launch, `--disable-approval --trust-workspace --model mock-model`, plus `--provider meta --base-url http://127.0.0.1:18800`. That base URL is the logging Meta Responses mock (`scripts/manual/muse-version-audit/mock.py`; same protocol, control files under `/tmp`).
- **Input:** prompts go in as AgEnD sends them: `set-buffer`, `paste-buffer -p`, a 0.3 s settle, then `send-keys Enter`.
- **Normalization:** none. The workspace is `/home/u/work`, which the status bar shows as `~/work`.

## The process-loss resume (`resume_reconcile:orphaned_by_process_loss`)

Each run used a fresh HOME:

1. Start with the production flags.
2. Paste `please do the long thing` and wait 6 s. This is the `*-inflight` capture.
3. Lose the process.
4. Start again with the same flags plus `resume <id>`, as `MuseBackend.buildCommand` does. The id is the newest session directory under `~/.local/share/muse/sessions/`. Wait 9 s. This is the `*-resumed` capture.
5. Paste `carry on`. This is the `*-after-turn` capture.
6. Run `/quit`. This is the `*-quit` capture.

| Capture | What was in flight | How the process was lost |
|---|---|---|
| orphan-stream-* | mock mode `slow`: the text reply never completes | `pkill -9` on the muse binary |
| orphan-tool-* | mock mode `tool`, args `{"command":"sleep 300"}`, run with `--disable-sandbox` | `pkill -9` |
| orphan-tool-hup-resumed | the same tool, `--disable-sandbox` | `tmux kill-server` (SIGHUP), in the `--init` container |
| orphan-bg-* | the tool with `"yield_time_ms":1000`, so it is backgrounded; `--disable-sandbox` | `pkill -9` |

`--disable-sandbox` is needed only because the container has no usable OS sandbox. With the sandbox on, `sleep 300` fails in 0.1 s, so nothing is running when the process is lost. It makes no claim about the sandbox itself.

`orphan-tool-session.jsonl` (and its 1.4.12 control) holds the first `route_facts` line of that session's `session.jsonl` plus every line naming `orphaned_by_process_loss`, verbatim. Those lines are written on resume: one run terminal `cancelled` and two task cancellations. The stream and tool runs log 3 such records on both versions, the background run 1. Both versions use the same schema and keys.

**Trap:** in a container whose PID 1 does not reap, `tmux kill-server` re-parents the HUP'd muse to PID 1, where it stays a zombie. Its pid still answers a liveness check, so the next `resume <id>` opens the session picker with "that session is already open in another window". This happens on both versions, and it does not happen under `--init`. It is a rig artifact, not muse behaviour, and it is why `orphan-tool-hup-resumed` comes from the `--init` container.

## The other captures

These were re-run on 1.4.13, plus 1.4.12 where a `compare-1.4.12-` twin exists. They use the same procedure as the 1.4.11 set (`tests/fixtures/muse-1.4.11/SOURCES.md`). After normalizing ids, times, the version and the cycling working glyph (◇ ◆ ◈), every 1.4.13 pane equals its 1.4.12 pane. The one exception is the orphan-stream panes, where a blank row sits one line higher.

| Capture | Procedure |
|---|---|
| echo-idle / echo-busy / echo-done | `--provider echo --echo-delay-ms 3000`; paste `hello echo` |
| echo-quit / echo-resumed | `/quit`, then `resume <id>` |
| echo-after-escape | `--echo-delay-ms 4000`, paste `cancel me`, Escape after 1 s |
| resume-missing | `resume 01a00000-0000-7000-8000-000000000000` |
| first-run-trust-dialog | Meta mock, no `--disable-approval --trust-workspace` |
| logged-out | no `META_API_KEY`, no provider flag |
| meta-idle / meta-done | mock mode `text`; paste `say something` |
| prod-escalation-denied | mock mode `tool`, args `{"command":"echo hi","sandbox_permissions":"require_escalated",…}`, production flags |
| approval-escalated (+ -after-esc) | the same, without `--disable-approval` |
| approval-untrusted-staged (+ -after-1) | `--approval-mode untrusted`, args `{"command":"ls -la"}` |
| prod-rate-limited | mock mode `429` |
| prod-usage-limit | an HTTP 402 with `{"error":{"message":"Usage limit reached","type":"usage_limit_reached"}}`, as on 1.4.11 |

The new 1.4.13 turn notice ("Usage limit reached / This turn stopped because your usage limit was reached. / …") was not reached offline. These mock shapes all failed to produce it:

- 402 or 403 with `tier_limit_error`: muse shows `model failed: API error …`;
- 429 with `usage_limit_exceeded` or `tier_limit_error` bodies: muse treats them as an ordinary retry;
- an SSE `response.failed` or `error` event;
- a `response.subscription_usage` frame at 100–120%.

The test therefore checks the binary's exact text, not a capture.
