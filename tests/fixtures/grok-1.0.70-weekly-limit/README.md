# grok 1.0.70 weekly-limit modal (#2872)

Captured offline on 2026-10-30 with the 1.0.70 audit rig (`tests/fixtures/grok-1.0.70-audit/rig`, a `--network none`
container, a dummy key, `mock.js`'s 402 "Weekly usage limit reached"). The script is `wl.sh` (in this directory):
`error turn b` → `modal`; `X` (Shift+x) → `after-shift-x`; a normal turn; then a second limit, `Escape` →
`modal-scrollback-focus` (the modal stays, focus moves to the scrollback), `X` → `after-esc-then-shift-x`.

`requests.txt`: the mock's request count. Shift+x sent nothing (5 → 5): it dismisses without choosing an option.
