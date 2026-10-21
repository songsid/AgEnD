# kiro-cli 2.33.0 audit against 2.32.0 (2026-10-21, #2345)

The baseline is 2.32.0, the last audited release.

## Artifacts

| | 2.32.0 | 2.33.0 |
|---|---|---|
| tarball `kirocli-x86_64-linux.tar.gz` sha256 | `05989f9bfe465b304e8d1b2dba50aec2b84fcc1deaa4c0773af3f539d6e0d312` | `fdce2898458e23346e63c7a87959cf458290bc44c080951b099c03862056933b` (equals the release manifest's) |
| `bin/kiro-cli` sha256 | `58abd8b474b31588c463d321d70dc223a1ea4bbed9048c163a8d485f0f05e4dd` | `a2960fad7e3a5c5d36412c9c5148f5e02e49ca90b3202d06f58446e238e1cebd` |
| `bin/kiro-cli-chat` sha256 | `5ba2a13daaed1146533b6274d5967a4b0a20a5ffe85e00f5fdb1a2219d2d48e9` | `acda392c3cac10fc24c72025ada0f9c710034af1eb9b932812938720b3e663bd` |
| `tui.js` (unpacked to `~/.local/share/kiro-cli/` on the first `--v3`) sha256 | `eba39f7b7914f6088859687e0b2cd759ee78715e9a90514f9fcf13b467432cd0` | `13cd1eb0a4c4c291ce7a64f7b7d8f6913f217929364020b8a5020d9d61fe1cba` |

- `../kiro-help/chat-help-2.33.0.txt` is `kiro-cli chat --help` from 2.33.0. It is byte-identical to 2.32.0's (sha256 `f8bc761b…`). Against 2.30.0 only the `--cloud` description changed, so the pinned flags are the same.
- `tui-2.33.0-workspace-trust.js.txt` is the workspace-trust component, copied verbatim from 2.33.0's `tui.js`: its strings, its variants, and the launch check that shows it. 2.32.0's `tui.js` has no `workspaceTrust` at all.
- The `*.strings.txt` files list each detector literal's count in the binary, with the bytes around its first hit. They were written by a byte search; no kiro code was run for them.

## Static precheck (`precheck-2.32.0-2.33.0.txt`, run by the upstream watch)

**MAJOR, hard=2; hinted=1.** None of these is a detector change:
- **The two missing literals** both come from `kiro-cli`'s sign-in prompt. 2.33.0 builds that line from styled fragments (`, let's get you signed in!` and ` to continue to the browser or `, with `enter` and `esc` coloured on their own), so neither whole sentence is in the binary any more (`kiro-cli-*.strings.txt`). The painted screen is byte-identical, escapes included (`login-expired-*.pane-e.txt`).
  - The `[trust]` literal `esc to cancel` was only ever found inside that sign-in string. The trust-all-tools dialog's tail is drawn at runtime.
- **The hinted "new prompt" and the gone `rate limit reached:Monthly request limit reached`** come from a re-ordered string pool. ` ⚠️  Kiro rate limit reached:` used to be followed by `Monthly request limit reached` and is now followed by an existing sentence. Every rate-limit, quota and throttling literal is still present (`kiro-cli-chat-*.strings.txt`).
- **The count changes** are exceptions still present in the AWS SDK tables.

The rate-limit and quota screens need a server response, so they cannot be reached offline. Their pane coverage stays `../kiro-2.29.1-audit/`.

## Live captures

The setup was the same as for 2.30.0:
- an isolated `HOME`/`XDG_*`, run under `unshare -rn` with `coredump_filter` 0;
- a dummy social token in the scratch `data.sqlite3`;
- a private tmux socket, at 120 columns (80 where the name says so).

The host's kiro install and data were not touched. Files were captured with `capture-pane -p`, and `-e` for `*.pane-e.txt`.

| file | launch | what |
|---|---|---|
| `login-expired-<v>` | `kiro-cli chat`, no token | the expiry fallback; identical in both versions |
| `login-menu-<v>` | `kiro-cli login` | "Select login method"; identical |
| `tui-trust-cursor0-<v>`, `tui-trust-cursor1-<v>`, `tui-ready-<v>` | `chat --tui --agent-engine=v2 --trust-all-tools` | the trust-all-tools confirmation before and after one Down, then the composer after Enter; identical |
| `v3-2.32.0-first-screen` | 2.32.0 `chat --v3 --trust-all-tools` | the trust-all-tools confirmation, with no workspace prompt |
| `v3-workspace-120-2.33.0`, `v3-workspace-80-2.33.0` | 2.33.0 `chat --v3 --trust-all-tools`, an untrusted folder | **new:** "Trust this workspace?" |
| `v3-workspace-home-80-2.33.0` | the same, in `$HOME` | the home variant (not saved, so it is asked every launch; no revoke line) |
| `v3-workspace-cursor-decline-2.33.0` | after one Down | the cursor on "Don't trust, exit" |
| `v3-workspace-declined-2.33.0` | after Enter on it | `Not trusted: <cwd>. Kiro exited without loading this folder.` The wrapper's `EXIT=` line was removed. |
| `v3-trust-after-workspace-2.33.0` | after Enter on "Trust, continue" | the trust-all-tools confirmation; `permissions.yaml` now holds `workspaceTrusted: true` |
| `v3-relaunch-trusted-80-2.33.0` | a relaunch in that folder | no workspace prompt |
| `v3-ready-2.33.0` | the patched drive (below) | the V3 composer |

### Patched drive

`KiroBackend.getStartupDialogs()` from this branch read each live pane, and the first active entry chose the keys, as the daemon does:
- 2.33.0 V3, folder, 120 columns: `kiro-workspace-trust-confirm` Enter, then `kiro-trust-all-tools-step` Down, then `kiro-trust-all-tools-confirm` Enter, then ready.
- 2.33.0 V3, home, 80 columns: the same three steps, then ready. No `permissions.yaml` was written for home.
- 2.32.0 V3: Down, Enter, then ready.

On main, no startup or runtime entry matches the workspace prompt.
