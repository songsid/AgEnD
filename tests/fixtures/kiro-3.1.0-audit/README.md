# kiro-cli 3.1.0 live captures (2026-11-06, upstream audit vs 3.0.0)

Real Linux x86_64 release from `prod.download.cli.kiro.dev/stable/3.1.0/`:
- release tar `kirocli-x86_64-linux.tar.gz` SHA256 `006835b2f4f433f55bb02601cd3053ccb10bd3d408478719c33d320f18e46ba5`, the same as the vendor manifest;
- binary SHA256 `cc780572fb09eae619ab80f93dc06ae67787c1a444e4e012ba3b7d4e9a993228`; `kiro-cli --version` → `kiro-cli 3.1.0`.

**How they were captured.** Each capture ran offline:
- under `unshare --user --map-current-user --net`, so there was no network and the user was the ordinary uid;
- with a scratch HOME and XDG dirs, core dumps off, `KIRO_NO_AUTO_UPDATE=1`;
- in a private tmux socket, with the cwd `/tmp/k310/o/work`.

No account was used. Where a token was needed, it was a never-valid dummy social token written into the scratch
`data.sqlite3`: `expires_at` 2099 for "valid", 2000 for "expired". Only one key was pressed in the whole run: Enter on
"Trust, continue" for the scratch work folder, to reach V3's composer. "hello" was then typed into that composer. Kiro
could not reach a model, so the turn ended on its offline error.

| file | command | shows |
|---|---|---|
| `expired-tui-{120,80}` | `chat --tui --agent-engine=v2`, expired token | "You are not logged in. Login now?" / Yes / No |
| `expired-v3-{120,80}` | `chat --v3`, expired token | the same screen |
| `classic-{120,80}` | `chat --legacy-ui --agent-engine=v1 --trust-all-tools`, valid token | "Kiro CLI 3.0 is here. … The Classic experience is no longer supported." / Continue with V3 / Exit |
| `launch-v2home-{120,80}` | plain `chat` in a home whose `cli.json` saved `chat.agentEngine: v2` | "Kiro CLI 3.0 is here. … V2 … will be removed in January." / Switch to V3 / Keep V2 (the ease-in is gone) |
| `launch-fresh-{120,80}` | `chat --v3 --trust-all-tools` in a fresh home | "Welcome to Kiro CLI V3", then "Trust this workspace?" / Trust, continue / Don't trust, exit |
| `trust-tui-{120,80}` | `chat --tui --agent-engine=v2 --trust-all-tools` | the "Kiro CLI V3 is here." banner, then the trust-all-tools confirmation (No, exit / Yes, I accept / Yes, and don't ask again) |
| `v3-after-trust-{120,80}` | `chat --v3`, after "Trust, continue" | 3.1's new "▸ What's new — Approve for me, cloud sessions, memory, local sandbox and specs." fold above the composer `›  ask a question or describe a task ↵` |
| `v3-working-{120,80}` | the same pane, "hello" sent | `ᗣ Thinking... (esc to cancel)` and the composer row `›  Kiro is working · 0s · Type to steer · Ctrl+S to queue` |
| `v3-after-turn-{120,80}` | the same pane, after the turn | "• Kiro could not load the available models. Please try again." and the ready composer |
| `chat-help.txt` | `kiro-cli chat --help` | every launch flag AgEnD uses is still there |

**What this half could not reach offline.** A tool-approval prompt needs a model to call a tool. So does 3.1's new
"Approve for me" mode, and any Cedar-policy wording it brings. The static half (Fable) covers those strings. A
real "Kiro rate limit reached:" screen needs the service, and so does the "Authentication Error" next to it; the
literals are unchanged per the static half. These captures do not raise `KIRO_TESTED_MAX`.
