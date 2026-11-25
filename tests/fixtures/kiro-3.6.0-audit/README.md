# kiro-cli 3.6.0 live captures (2026-11-25, upstream audit vs 3.5.0, M-3752)

Real Linux x86_64 release, from the daily upstream watch's download:
- release tar `kirocli-x86_64-linux.tar.gz`, SHA256 `a9d356f0f1a127a2587f63e806fcec00b98b916b9e5cf61822f7e179d6f7c7ed`;
- binary SHA256 `b1549bd29361cb857a105ef2b43f4764023c97aaa6d59520cd42398ffdb32a0a`; `BUILD-INFO` says version 3.6.0, hash `28118225`;
- `kiro-cli --version` prints `kiro-cli 3.6.0`.

The audited 3.5.0 (tar SHA256 `98f016b746b342d8337a0e937cabecc381037e2e920ea0ffaae649e51ef59d4e`) was captured the same way for comparison. Its captures read the same as these, apart from the scratch folder names.

**How they were captured.** Each capture ran offline:
- under `unshare -cn`, so there was no network and the user was the ordinary uid;
- with a fresh scratch HOME per scenario under `/tmp/k360/h/`, scratch XDG folders, core dumps off and `KIRO_NO_AUTO_UPDATE=1`;
- in a private tmux socket, with the cwd `/tmp/k360/o/work`;
- stopped with SIGINT only.

No account was used. Where a token was needed, it was a never-valid dummy social token written into the scratch `data.sqlite3`: `expires_at` 2099 for "valid", 2000 for "expired".

Keys pressed in the whole run:
- Enter on "Trust, continue" for the scratch work folder, to reach V3's composer;
- "hello" typed into that composer, then Enter.

Kiro could not reach a model, so the turn ended on its offline error. The busy row was caught by reading the pane every 20 ms after Enter.

| file | command | shows |
|---|---|---|
| `expired-tui-{120,80}` | `chat --tui --agent-engine=v2`, expired token | "You are not logged in. Login now?" / Yes / No |
| `expired-v3-{120,80}` | `chat --v3`, expired token | the same screen |
| `classic-{120,80}` | `chat --legacy-ui --agent-engine=v1 --trust-all-tools`, valid token | "Kiro CLI 3.0 is here. … The Classic experience is no longer supported." / Continue with V3 / Exit |
| `launch-v2home-{120,80}` | plain `chat` in a home whose `cli.json` saved `chat.agentEngine: v2` | "Kiro CLI 3.0 is here." / Switch to V3 / Keep V2 |
| `launch-fresh-{120,80}` | `chat --v3 --trust-all-tools` in a fresh home | "Welcome to Kiro CLI V3", then "Trust this workspace?" / Trust, continue / Don't trust, exit |
| `trust-tui-{120,80}` | `chat --tui --agent-engine=v2 --trust-all-tools` | the "Kiro CLI V3 is here." banner, then the trust-all-tools confirmation |
| `v3-after-trust-{120,80}` | `chat --v3`, after "Trust, continue" | the "What's new" fold above the composer `›  ask a question or describe a task ↵` |
| `v3-working-{120,80}` | the same pane, "hello" sent | `ᗣ Thinking... (esc to cancel)` and `›  Kiro is working · 0s · Type to steer · Ctrl+S to queue` |
| `v3-after-turn-{120,80}` | the same pane, after the turn | "• Kiro could not load the available models. Please try again." and the ready composer |
| `chat-help.txt` | `kiro-cli chat --help` | every launch flag AgEnD uses; `--legacy-ui` now "Show the Classic upgrade prompt (Classic no longer runs)" |

**The static half.** The precheck's 21 missing literals were all plain-text copies in the main Rust binary. kiro also carries its TUI (`tui.js`), an engine tar and two runtime ELFs as zstd frames inside that binary; the precheck does not read those.

Counted across all parts:
- 15 texts are gone from every part. They belonged to the Classic (v1) harness 3.6.0 deleted: the rate- and request-limit screens, "having trouble responding", auth/login expiry, the Classic-deprecation nudges, `q_prompt`, `/agent swap` and the erase-history confirm. `sources.json` now retires them after 3.5.0. AgEnD already refuses a Classic launch on kiro 3.x, and the detectors stay for hosts below 3.0.
- 6 are still in `tui.js` or the engine tar with unchanged counts: "Select model", "type to search", "Completed in", "using tool", "is ambiguous" and "bearer token". `sources.json` marks them embedded-only.
- The 17 changed counts are the same deletion: shared text losing its Classic copies.
- The one APPEARED literal, "go back", is prose in an embedded theme prompt ("go back to classic"), not a screen.

**What this half could not reach offline.** A tool-approval prompt and the V3 question card need a model, and a real throttling or auth-error screen needs the service. Their text in `tui.js` and the engine tar is unchanged from 3.5.0.
