# kiro-cli 2.34.0: another program owns the pane (#2682, 2026-10-26)

These are offline captures of the real 2.34.0 TUI (`--tui --agent-engine=v2 --trust-all-tools`) and V3 (`--v3`) at 120 columns, on the TUI's own mock agent.
- Rig: `../kiro-2.34.0-audit/rig/`. It sets `KIRO_MOCK_ACP=true` and `KIRO_TEST_MODE=1`, uses an isolated HOME under `unshare -rn`, a private tmux socket, and no account. The host's kiro is untouched.
- Environment: `EDITOR=vi PAGER=less`, except for the nano and more frames.
- For `/kvim`, Neovim 0.11.4 was on PATH: the official linux-x86_64 tarball, whose sha256 matches GitHub's digest for the asset.
- Scratch paths are shortened to `~/k2682-work` and `/tmp/k2682`.

| File | What it shows | Takeover? |
|---|---|---|
| `tui-editor-vi`, `v3-editor-vi` | `/editor`: vi on `"/tmp/kiro-editor-XXXXXX/prompt.md"`, `~` rows, ruler. No composer. | yes |
| `tui-editor-nano` | `/editor` with `EDITOR=nano`: `GNU nano … /tmp/kiro-editor-…/prompt.md`, `^G Help … ^X Exit` | yes |
| `tui-transcript-less`, `v3-transcript-less` | `/transcript`: less on `/tmp/kiro-raw-XXXXXX/conversation.md (END)` | yes |
| `tui-transcript-more` | `/transcript` with `PAGER=more`: `--More--(75%)`. A transcript shorter than the screen exits `more` at once. | yes |
| `tui-bang-running`, `v3-bang-running` | `!sleep …`: `  › !sleep …` then `• Running...`. The composer reads `Kiro is working · Type to steer`. | yes |
| `tui-bang-paste-went-to-command` | A paste plus Enter during that command. The text is echoed by the command, under its row, and never reaches the composer. | yes |
| `tui-bang-cat-running` | `!cat`, waiting on stdin | yes |
| `tui-bang-less`, `tui-bang-less-scrolled`, `tui-bang-vi-ruler`, `tui-bang-vi-insert` | Full-screen `!less`/`!vi` (kiro's spawnSync set). The less file name, then `:`; vi's ruler, then `-- INSERT --` | yes |
| `tui-kvim-focused` | `/kvim`: `── Neovim · focused · Ctrl+\ to chat · :q to close ──`. The idle composer is still shown. | yes |
| `tui-kvim-focused-paste-went-to-nvim` | A paste while focused: the text lands in the nvim buffer, and the composer stays empty. | yes |
| `tui-kvim-unfocused`, `tui-kvim-unfocused-paste-in-composer` | After Ctrl+\: `Neovim · unsaved: [No Name] · Ctrl+\ to edit`. A paste lands in the composer. | no |
| `tui-fullscreen`, `tui-fullscreen-delivery` | `/fullscreen`: the same composer, and a paste plus Enter starts a turn (the second frame, busy with an agent turn) | no |
| `tui-bang-done`, `v3-bang-done`, `tui-idle-after-transcript`, `v3-idle-after-editor` | Back at the idle composer after each one | no |
| `tui-reply-unrecognized` | `/reply` on the TUI: `Unrecognized command: /reply`. It exists only on legacy. | no |

The source, from 2.34.0's `tui.js`:
- **Editors and pagers.** `/editor`, `/transcript` and the full-screen `!` set (`vim vi nvim nano emacs less more most top htop btop tmux screen ssh`) run through `spawnSync(…, {stdio: "inherit"})`. kiro is frozen until they exit. The temp directories are `kiro-editor-` and `kiro-raw-`, made with `mkdtemp`.
- **Other `!` commands.** Any other `!cmd` runs in a PTY that forwards keystrokes (`_shellEscapeWriter`). The state sets both `isProcessing` and `isShellEscape`. The placeholder checks `isProcessing` first, so the composer shows the busy steer/queue row, and its `running shell command` placeholder is never reached.
- **The `/kvim` header.** The panel header comes from `hOr`. Focused, it reads `Neovim · focused · Ctrl+\ to chat · :q to close` or `Neovim · the agent is waiting on you: Ctrl+\ to answer`. Unfocused, it reads `Neovim · Ctrl+\ to edit` or `Neovim · unsaved: … · Ctrl+\ to edit`.

**Legacy** (`--legacy-ui --agent-engine=v1`, with and without `--trust-all-tools`) was reached offline with an explicit `--model auto`, which skips the model fetch that otherwise stops it, plus `KIRO_MOCK_CHAT_RESPONSE` for the replies. `VISUAL=vi` is needed because legacy refuses an empty `VISUAL`.

| File | What it shows | Takeover? |
|---|---|---|
| `legacy-idle`, `legacy-notrust-idle`, `legacy-notrust-idle-after-editor` | The prompt row at the bottom: `4% !>` with trust-all, `4% >` without | no |
| `legacy-editor-vi`, `legacy-reply-vi`, `legacy-notrust-editor-vi` | `/editor` and `/reply`: vi on `"/tmp/q_prompt_<uuid>.md"`. `/reply` is pre-filled with the last answer. | yes |
| `legacy-bang-running`, `legacy-notrust-bang-running` | `!sleep …`: the bottom row is the prompt with the command after the marker. No output yet, and the pane is silent. | yes |
| `legacy-bang-paste-went-to-command` | A paste plus Enter during it: echoed by the command, no prompt row at the bottom | no (held: no prompt) |
| `legacy-bang-done-typeahead-stranded` | After the command: the paste is left as typeahead on the new prompt row and never submitted, the #kiro-enter-drop shape | no (a draft) |
| `legacy-bang-vi` | Full-screen `!vi f.txt`: its ruler | yes |
