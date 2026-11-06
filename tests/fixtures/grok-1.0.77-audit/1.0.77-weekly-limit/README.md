# grok 1.0.77 weekly-limit modal

Host-isolated (private tmux, scratch HOME, mock 402). Same script shape as `tests/fixtures/grok-1.0.70-weekly-limit/wl.sh`.

- `modal` — picker, `Shift+x:dismiss`.
- `after-shift-x` — X from the picker; mock request count 5→5.
- `next-turn` — a normal turn after that dismissal.
- `modal-scrollback-focus` — Esc; legend `Tab/Space:question`.
- `after-esc-then-shift-x` — X from scrollback: **modal stays** (1.0.70 dismissed).
- `after-esc-then-space` — Space restores `Shift+x:dismiss`.
- `after-esc-space-then-x` — X then dismisses.
