# kiro-cli 3.3.0 live captures (2026-11-13, upstream audit vs 3.2.1)

Real Linux x86_64 release from `prod.download.cli.kiro.dev/stable/3.3.0/`:
- release tar `kirocli-x86_64-linux.tar.gz` SHA256 `b88142aa02789504ac77fdf6ee829f0f4bdc9ce2e5dd0cc73084e105003c8fc3`, the same as the vendor manifest (`stable/latest/manifest.json`);
- binary SHA256 `8128eb9c1a2146827065274a0e292021022b49541d2e36796e15e75dd826e00e`; `kiro-cli --version` → `kiro-cli 3.3.0`.

**How they were captured.** Each capture ran offline:
- under `unshare --user --map-current-user --net`: no network, and the user is the ordinary uid;
- with a scratch HOME and XDG dirs, core dumps off and `KIRO_NO_AUTO_UPDATE=1`;
- in a private tmux socket, with the cwd `/tmp/k330/work`.

Every capture below was repeated with the same script on 3.2.1, and the two were diffed.

No account was used. Where a token was needed, it was a never-valid dummy social token written into the scratch
`data.sqlite3`: `expires_at` 2099 for "valid", 2000 for "expired". kiro was never sent SIGTERM; sessions ended through
`/quit` or Ctrl+C. The keys pressed were the ones AgEnD sends:
- Enter on "Trust, continue";
- Down, then Enter, on the trust-all-tools confirmation;
- "hello" typed into the composer, then `/session-id` and `/quit`.

Kiro could not reach a model, so each turn ended on its offline error.

| file | command | shows |
|---|---|---|
| `expired-{tui,v3}-{120,80}` | `chat --tui --agent-engine=v2` / `chat --v3`, expired token | "You are not logged in. Login now?" / Yes / No |
| `classic-{120,80}` | `chat --legacy-ui --agent-engine=v1 --trust-all-tools`, valid token | "Kiro CLI 3.0 is here. … The Classic experience is no longer supported." / Continue with V3 / Exit |
| `launch-v2home-{120,80}` | plain `chat` in a home whose settings say `chat.agentEngine` v2 | "Kiro CLI 3.0 is here. … V2 … will be removed in January." / Switch to V3 / Keep V2 |
| `trust-tui-{120,80}` | `chat --tui --agent-engine=v2 --trust-all-tools` | the "Kiro CLI V3 is here." banner, then the trust-all-tools confirmation (No, exit / Yes, I accept / Yes, and don't ask again) |
| `launch-fresh-{120,80}` | `chat --v3 --trust-all-tools` in a fresh folder | "Trust this workspace?" / Trust, continue / Don't trust, exit |
| `v3-trust-all-{120,80}` | the same pane, after "Trust, continue" | the same trust-all-tools confirmation, as on 3.2.1 |
| `v3-after-trust-{120,80}` / `tui-idle-{120,80}` | past the confirmation | the composer `›  ask a question or describe a task ↵` under "Trust All Tools active, confirmations are off · /quit to exit" |
| `v3-working-{120,80}` | "hello" sent on V3 | `ᗣ Thinking... (esc to cancel)` and `›  Kiro is working · 0s · Type to steer · Ctrl+S to queue` |
| `v3-after-turn-{120,80}` / `tui-after-turn-{120,80}` | after the offline turn | "• Sign in to Kiro to send a prompt." (V3) / "• dispatch failure" (TUI), then the ready composer |
| `{tui,v3}-session-id-{120,80}` | `/session-id` after the turn | `• Session ID: <id>` / `  Resume with: kiro-cli --resume-id <id>` |
| `{tui,v3}-quit-{120,80}` | `/quit` at idle | "Session ended." / "Resume with: kiro-cli --resume-id <id>"; the process exits at once |
| `chat-help.txt` | `kiro-cli chat --help` | every launch flag AgEnD uses is still there; only the `--trust-tools` help text grew |

**3.3.0 against 3.2.1, the same script on both:**
- Every screen above is identical, apart from these:
  - The right-aligned `/copy to clipboard` hint (TUI) and `/sessions to resume · /copy to clipboard` hint (V3) under the composer are gone. AgEnD only allows such hints there; it never requires them.
  - The spinner frame.
- A relaunch with `--resume-id <id>` from the `/session-id` alert opens the same composer on both.
- TUI session files (`.kiro/sessions/cli/<id>.json`) have the same shape. V3's `session.json` gains `universalBackgroundTool: false`.

**What the precheck's MAJOR was (static):**
- *New:* "Stopping background jobs (press Ctrl+C to skip)" and "closing the session with running jobs did not complete" (launch.rs).
  - They belong to kiro's `background_execution` feature: shell jobs that outlive their tool call.
  - That feature is "Dark-shipped at 0%" for internal nightly users, and is on only with `KIRO_ENABLED_FEATURES`, which AgEnD never sets. `/quit` at idle shows neither string.
- *Unchanged:* "Kiro rate limit reached:", "Request quota exceeded. Please wait a moment and try again.", "Monthly request limit reached", "The conversation history has overflowed." and "Error: the turn was cancelled before it finished" have the same text and counts as in 3.2.1. Only their neighbours in the binary moved, so the precheck's "gone" monthly limit is a reordering, not a removal.
- All 136 of AgEnD's kiro literals are unchanged (0 missing, 0 count changes).

**What this could not reach offline:**
- A real throttling, history-overflow, monthly-limit, turn-cancel or compaction screen needs the service.
- A V3 question card or a tool approval needs a model.

Their literals are unchanged. These captures do not raise `KIRO_TESTED_MAX`.
