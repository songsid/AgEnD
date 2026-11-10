# Codex retained post-Enter receipt frames (#3578)

Fresh real Codex 0.167.0, SHA-256 `cdcb45aaa01d0f14e298985e09465aebccd47f64ecd298aea44814af7b62bbda`, with a private CODEX_HOME/tmux socket and a localhost mock Responses API inside `unshare -Urn`. Only loopback enabled; no routes, account, vendor call or live fleet. The audited cached binary is unchanged from the 0.167 audit. Automatic update checks are disabled. No tools are requested by the mock.

- `idle`: captured before the scratch message.
- `enter-retained`: captured by the same private tmux command queue immediately after its first Enter (5 ms), still showing the message in the composer.
- `submitted-busy`: captured 117 ms after Enter; the receipt marker is in the transcript, the composer is empty and Codex is working. The mock holds its response open.

Only trailing empty viewport rows are removed from the test fixtures. These are otherwise raw pane layouts from this capture, not reconstructed or copied from the external reporter. All identities/contents are deliberately synthetic; paths are owned scratch paths. The regression substitutes only the receipt UUID when connecting the frame to its fresh private SQLite receipt, keeping its width and all layout evidence unchanged.

The offline latency replay deliberately holds the busy frame for over 30 seconds and feeds it through the production judge and readiness timers in a private tmux. This isolates a mechanism; it does not recreate the reporter's unknown stream or establish the cause of historical receipt creation-to-delivery intervals.
