# Bundled tmux matrix (M-2457)

The per-version matrix in `docs/design/bundled-tmux.md` §2. Rerun all of it, on the new build, whenever the pin in
`scripts/release/tmux-sources.json` changes, and record the results in the note. Every leg runs on private sockets in
throwaway containers. None of them touches a live tmux server.

| Leg | Script | Needs |
|---|---|---|
| Leak: control client and CLI, 180 s RSS | `container-legs.sh <bundle> leak` (runs `leak-repro.sh`) | Docker |
| #735 stress: 24 panes of random bytes and escapes, 600 s | `container-legs.sh <bundle> stress` (runs `stress-735.sh`) | Docker |
| #309 through AgEnD: first messages after a fresh start, two at once, twice | `delivery-309.sh` | a rig (below) |
| #309 raw: `paste-buffer -p` + Enter with no settle | `raw-309.sh` | a rig (below) |

`<bundle>` is a build output directory: `scripts/tmux/build-tmux.mjs --out <dir>` writes `<dir>/tmux-<target>/`.

## The rig interface (`RIG=<script>`)

The #309 legs drive real Claude Code and Codex CLIs against mock model APIs and a mock Telegram, inside a container
with `--network none`. That needs CLI binaries, mocks and an AgEnD build, which are not in this repo. A rig is any
script that offers these verbs:

| Verb | Does |
|---|---|
| `start` | A new container with the tmux under test (`$TMUX_BUNDLE`) first on PATH, and the fleet started. The fleet has agents `ccm` and `ccc` (Claude Code: MCP and CLI mode) and `cxm` and `cxc` (Codex: MCP and CLI mode) on Telegram topics 101, 102, 201 and 202. The mock model APIs reply `PONG-<tag>` to `PING-<tag>`. |
| `stop` | Remove the container. |
| `r '<cmd>'` / `x '<cmd>'` | Run a command as the fleet user / as root. The fleet user's environment points Claude Code at the mock API. |
| `send <topic> <text>` | Post a user message to a topic through the mock Telegram. |
| `calls` | The mock Telegram's recorded calls, as JSON `{ result: [{ method, params }] }`. |
| `wait-fresh` | Wait until every agent has a window newer than the last `agend fleet stop`. |
