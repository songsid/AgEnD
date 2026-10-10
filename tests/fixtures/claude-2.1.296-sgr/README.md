# Claude Code 2.1.296: dim text in the composer (#1582)

Captured live on 2026-10-11 from Claude Code 2.1.296 (sha256 `24972e3bc859fab2b46ed4c1e51f7d6130f06d3bd550811a114640de3370d0de`).

The rig was `scripts/manual/claude-version-audit` with these settings:
- a mock Anthropic API, so no account;
- an isolated HOME;
- a private tmux socket;
- AgEnD's production launch (`gen-cmd.ts`: `writeConfig` + `buildCommand`, with its statusLine);
- `CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=1` (otherwise behind the `tengu_chomp_inflection` GrowthBook flag).

The mock answered the `[SUGGESTION MODE: …]` request with "add a correction note to that decision".

Each screen comes as two files: `*.pane.txt` is `capture-pane -p` (what the daemon reads), and `*.ansi.txt` is `capture-pane -p -e` (what `/api/pane` serves to `/view`).

| file | screen | composer row with `-e` |
|---|---|---|
| `placeholder` | a fresh session's empty box | `❯`+U+00A0, `ESC[7m`T (the cursor), `ESC[0;2m`ry "fix lint errors" (**dim**) |
| `typed` | text pasted into the box, not sent | `❯`+U+00A0, the text in the default colour, `ESC[7m` space (the cursor) |
| `suggestion` | after the second turn: Claude's prompt suggestion | `❯`+U+00A0, `ESC[7m`a, `ESC[0;2m`dd a correction note to that decision (**dim**) |
| `enter-on-suggestion` | the same after a bare Enter | unchanged: Enter on a suggestion submits nothing, and the mock received no request |
| `pasted-over-suggestion` | a delivery-shaped paste typed over the suggestion | the paste replaces the suggestion, and Enter submitted exactly the pasted text |

In plain text, a suggestion and typed text are the same: `❯` + U+00A0 + text.

`suggestion.output.log` is the instance's `output.log` for the same suggestion state. It was recorded with `tmux pipe-pane` into a file, like AgEnD's own, during a second run of the same rig (two turns, then the suggestion). It is a cursor-addressed stream with no newline at all. The suggestion is in it as `ESC[7m` a `ESC[27m` `ESC[2m` `dd a correction note to that decision` `ESC[22m`. `get_instance_logs` returns this stream; since #1582 it marks the faint run `⟨dim⟩…⟨/dim⟩`.
