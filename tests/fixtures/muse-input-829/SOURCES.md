Captured from a live muse 1.4.2 on 2026-10-05: a scratch muse on a private tmux socket
(`tmux -L`), its own XDG config and work directory, with the prompts pasted and not sent
unless stated. Only the status bar's scratch path was replaced (`~/work/probe`).

- `empty` — idle, nothing typed.
- `single-line-human` — one line typed without AgEnD's marker.
- `multi-line-agend` — a four-row AgEnD-style paste, not sent.
- `long-paste-placeholder` — a 3000-char paste, collapsed by muse.
- `busy` — a turn running; the prompt's transcript echo sits above the busy line.
- `restored-after-escape` — the same turn after Esc: muse put the prompt back in the box.
- `cleared-after-escape` — that box after `C-u C-k BSpace DC` per row.

Wrapping, from a second live session at 80 columns (same isolation), each with
the exact text pasted beside it in `<name>.payload.txt`:

- `wrap-words` — a long line wrapped at a space; the space at the break is not drawn.
- `wrap-long-word` — a word longer than the row, cut at 77 columns.
- `wrap-double-space` — two spaces at the break: both dropped.
- `wrap-multiline` — hard newlines, an empty line, a 77-column line that fits.
- `wrap-after-one-round` / `wrap-after-two-rounds` — a three-line draft after one
  and two `C-u C-k BSpace DC` rounds (cursor at the end): one whole line goes per
  round, all of its rows.
