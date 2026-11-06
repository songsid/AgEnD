# grok 1.0.77 weekly-limit reset picker

Host-isolated capture, 2026-11-06. Private tmux (`-L grokresetpicker`), scratch HOME, dummy `XAI_API_KEY`, mock API on `127.0.0.1:18081` that returns 402 (`insufficient_quota`) then SSE success. Binary `grok 1.0.77 (50ca579fa996)` sha256 `b702950aa5827d855e493278ab6215a4e0f5bceb5bba6c6243a9f55cdd143b0a`. No live account.

1.0.77 shows this same three-option picker after a weekly 402 **and** after Try Again while the mock is still 402. Extra `resets_at` fields in the 402 JSON do not paint a reset-time line. After the mock starts succeeding, Try Again leaves the boxed composer (`Trying again…`).

The highlight is reverse-video (`SGR 7`), not a `❯` glyph. `tmux capture-pane -p` (what the daemon reads) cannot see it. Default highlight is option 1 (Upgrade — paid). Digit `3` does not move it. Two Downs land on `3 (○) Try Again`. Enter while still 402 re-shows the picker with the highlight back on option 1.

The list does **not** wrap. Down on option 3 stays on 3 (`down3.esc.txt`). Down×2 from option 2 is 2→3→3 (`from2.esc.txt` then `from2-downx2.esc.txt`). Down×2 from any start therefore ends on Try Again (1→3, 2→3 clamped, 3→3), so the sequence is start-independent.

| file | what |
| --- | --- |
| `modal.pane.txt` / `modal.esc.txt` | picker as the daemon sees it / with SGR (option 1 highlighted) |
| `down1.esc.txt` | one Down: option 2 |
| `down2.esc.txt` | two Downs: option 3 Try Again |
| `down3.esc.txt` | Down on option 3: stays on 3 (no wrap) |
| `from2.esc.txt` | highlight on option 2 (failed-Enter re-show, then one Down) |
| `from2-downx2.esc.txt` | Down×2 from option 2: still on 3 (clamped) |
| `digit3.esc.txt` | typing `3` leaves option 1 highlighted (`modal-run2.esc.txt` is the before) |
| `enter-still-402.pane.txt` / `.esc.txt` | Enter on Try Again while still limited: picker returns, highlight on option 1 |
| `enter-after-ok.pane.txt` | Enter on Try Again after the mock succeeds: composer is back |
