# Claude Code 2.1.317 file-send card (M-2296)

These rigs run a **private copy** of the Claude Code binary under test (`CLAUDE_BIN`) on a unique private tmux socket, in a scratch HOME and working directory, against a synthetic loopback Anthropic API with a fake key. They use no account, fleet, systemd service, live tmux server or operator settings. Each one removes its own tmux server and scratch HOME, and checks that every Claude it started has exited.

From the repository root, after `npm ci`:

```sh
CLAUDE_BIN=/path/to/private/claude npx tsx scripts/manual/claude-2317-file-send/capture-mcp-card.mts .artifacts/cc2317-mcp
CLAUDE_BIN=/path/to/private/claude npx tsx scripts/manual/claude-2317-file-send/deliveries.mts .artifacts/cc2317-deliveries
```

- **capture-mcp-card.mts** gives Claude an inert local MCP tool (`mcp-mock.cjs`, which never touches a file or the network). It captures the real permission card in default mode. That capture is the chrome for `tests/fixtures/claude-2.1.317-mcp-permission.pane.txt`, and the file-send fixtures are derived from it.
- **deliveries.mts** launches Claude as AgEnD launches agents (`--dangerously-skip-permissions`) through AgEnD's own `TmuxManager` and `Daemon`, in three states: idle, busy (a slow turn in flight) and just resumed (`--continue`). Each time, no runtime dialog matches the ordinary screen, the blocking-dialog probe is clear, a pasted delivery's Enter is sent, and the API receives the message.

**What these rigs do not show:** the live file-send card itself. It is raised for a claude.ai connector call that attaches local files (the email connector), which an offline rig cannot reach. Its fixtures are therefore derived from the 2.1.317 bundle and laid on the real card's chrome:
- the question variants `Rwt`, `Njo`, `Ljo` and `Twt`;
- the `* ` file gutter;
- Yes/No ordering and `defaultToNo`;
- `connectorFileSend: {bypassImmune: true, waivableInBypass: false}`.
