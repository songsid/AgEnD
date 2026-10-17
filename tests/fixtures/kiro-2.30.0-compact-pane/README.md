# kiro-cli 2.30.0: how `/compact` ends, on its own pane (board 907c7899)

Captured 2026-10-16 from the real kiro-cli 2.30.0 on Linux, in a private tmux server (120×40, `capture-pane -p -S -`),
in scratch working directories, with no fleet and no live instance. At most eight model requests in all (counting each prompt and each non-empty `/compact`), approved beforehand.
The paths are replaced (`/work/kiro-classic`, `/work/kiro-tui`, …) and trailing blanks are trimmed. Nothing else is
changed.

**Classic** (`--legacy-ui --agent-engine=v1`): a one-word prompt, `/compact`, and `/compact` again with Ctrl-C 1.5 s in.
A second, empty session: `/compact` alone.

| File | When |
|---|---|
| `classic-idle` | after the prompt's answer, before `/compact` |
| `classic-compacting` | 3 s after `/compact`: `2% > /compact`, `⠧ Creating summary...` |
| `classic-compacted` | it ended: the summary, then "The conversation history has been replaced with this summary." |
| `classic-recompacting` | the second `/compact`, 1.5 s in |
| `classic-ctrlc-stopped` | 13 s after Ctrl-C: the prompt `1% >` is back, nothing said, no second summary |
| `classic-too-short` | the empty session: "Conversation too short to compact." at once |

**TUI V2** (`--tui --agent-engine=v2`): a one-word prompt, `/compact`, then `/compact` with Ctrl-C 1.5 s in, with Esc
0.4 s in, and with Ctrl-C 0.3 s in. A second, empty session: `/compact` alone.

| File | When |
|---|---|
| `tui-idle` | after the prompt's answer, before `/compact` (the command is never echoed) |
| `tui-compacting` | 3 s after `/compact`: `• Compacting conversation...` |
| `tui-compacted` | it ended: the running line is replaced by the summary |
| `tui-recompacting`, `tui-ctrlc-still-compacted` | Ctrl-C 1.5 s in did not stop it: a second summary |
| `tui-esc-compacting`, `tui-esc-still-compacted` | Esc 0.4 s in did not stop it either: a third summary |
| `tui-too-short`, `tui-too-short-gone` | the empty session: "• Conversation too short to compact." at 0.5 s and 3 s, gone by 13 s |

Ctrl-C 0.3 s in did not stop it either: the session log (`~/.kiro/sessions/cli/<id>.jsonl`) holds four `Compaction`
records for the four `/compact`s.
