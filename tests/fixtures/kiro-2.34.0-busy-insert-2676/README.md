# kiro-cli 2.34.0 TUI: typed input while busy (#2676, 2026-10-26)

These are offline captures of the real 2.34.0 TUI (`kiro-cli chat --tui --agent-engine=v2 --trust-all-tools`, 120 columns). The binary is the one in `../kiro-2.34.0-audit/` (`bin/kiro-cli-chat` sha256 `596c48b3…`). It ran on the TUI's own test harness, with the rig in `../kiro-2.34.0-audit/rig/`:
- `KIRO_MOCK_ACP=true` gives an in-process mock agent.
- `KIRO_TEST_MODE=1` with `KIRO_TEST_TUI_IPC_SOCKET_PATH` lets the rig end a turn (`COMPLETE_TURN`).
- It used an isolated HOME under `unshare -rn` and a private tmux socket. No account was used, and the host's kiro was not touched.
- The scratch path is shortened to `~/k2676-work`.
- Pastes went in the way AgEnD sends them: `paste-buffer -p` (bracketed), then one Enter.

A turn is opened by sending a message. It stays busy (`Kiro is working · Ns`) until the rig ends it.

| File | What it shows |
|---|---|
| `tui-busy-steer` / `tui-busy-queue` | The empty busy composer in steer mode (the default) and in queue mode (after Ctrl+S). |
| `tui-steer-in-box` / `tui-queue-in-box` | A one-line paste in the box, first line on the `›` row. |
| `tui-multiline-in-box` | A three-line paste (marker, `[from:…]`, meta): first line on the `›` row, the rest indented two spaces. |
| `tui-wrapped-first-line-in-box` | A two-line paste whose first line is wider than the box. It is word-wrapped, and the rest goes on rows indented two spaces. On the idle composer, which paints a paste the same way. |
| `tui-collapsed-lines-in-box` | A 42-line paste collapsed to `›  42 lines ▸   Press Tab to expand`. |
| `tui-collapsed-3-lines-in-box` | Three lines over 500 characters: `3 lines ▸`. |
| `tui-collapsed-chars-in-box` | One line of 657 characters: `657 chars ▸`. |
| `tui-steer-tray`, `tui-queue-tray`, `tui-multiline-tray`, `tui-collapsed-tray` | After the one Enter: the box is the empty placeholder again, and the text is in the tray `◇ 1 message queued · ctrl+x expand` (or `3 messages queued` once more were added). |
| `tui-two-in-tray` | Two messages in the tray: `◇ 2 messages queued`. |
| `tui-tray-expanded` | Ctrl+X on the tray: the queued message's own text, marker included. |
| `tui-queue-sent` | Queue mode at the turn's end: the queued message is submitted as the next user turn (`› [agend-delivery-id:…] …`), exactly once. |
| `tui-steer-tray-at-idle-mock` | Steer mode at the turn's end on the **mock** agent. Its tray stays, because the mock never emits `AgentExecutionSteeringInjected`. Real runs inject the steer into the running turn: 2.27.1 (`../kiro-steer-1405/2.27.1-tui-steer-injected`) and 2.34.0 (Sentinel's D5, #2598). This frame documents the mock and is not evidence about real kiro. |

From 2.34.0's `tui.js`:
- A paste of more than 10 lines or 500 characters collapses: `WGt`, with `DQr=10` and `QQr=500`.
- The chip's label is `n>1 ? "${n} lines" : "${r} chars"`, then `▸`.
- The line count splits on `\r\n|\r|\n`, after CR/CRLF become LF. A trailing newline counts as a line.
- The character count is taken after kiro's own normalisation, which widens tabs. So it is not a proof of what was pasted.
