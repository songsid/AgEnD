# Hub room assistant runner (Track A, seam 4)

`RoomAssistantRunner` is the room lifecycle service. It has no process launcher or HTTP routes by itself. The Hub
host Fleet supplies a `RoomAssistantHost`; the rooms server consumes `RoomAssistant` from `types.ts`. An absent
provider remains disabled in the rooms server until the host adapter is wired.

The pilot defaults are three running instances and fifteen idle minutes (ranges 1–16 and 1–240). Waiting rooms
are admitted in arrival order. A room's turns stay serialized, while another room can use a free slot. When the
cap is full, the longest-idle room controller is stopped to admit the next waiting room. A working instance is never
evicted for capacity. Startup and physical stop drain both occupy a slot. A failed stop retains its slot and
pauses admission; the Fleet must resolve that process before replacing the service.

The pilot adapter may use a fresh one-shot worker for each ask; its room controller remains idle between asks.
`available().running` counts working/starting/draining owners, not idle controllers. The controller cap and fifteen
minute idle lifetime remain unchanged (Lumen's refinement at `ea4e347be`).

The runner snapshots the supplied room context and keeps its last thirty rows, oldest first, plus one older
replied-to room message marked `repliedTo: true` when supplied. A recent replied-to row is not duplicated. `forget` cancels
queued work and retires the current room owner; a late launch is stopped before its turn is sent, and a late
answer is discarded. `close` fences every owner synchronously, then awaits all launch/stop drains.

The host adapter must provide all of the following before enabling the assistant:

- A configurable instance root, with a separate empty working directory for every room launch.
- The Hub owner's selected backend/account. Only backends with native shell, file and other tools disabled are
  offered. No AgEnD tools, agent token, MCP servers or platform reply routing are provisioned.
- A text/Markdown result port, and a stop operation that resolves only after the owned process is gone.
- No other room's context, files or Fleet conversations supplied to an ask.

The first proposed adapter is one-shot Claude Code print mode with streaming JSON. Its documented `--tools ""` removes
built-in tools, and `--strict-mcp-config` with an empty MCP config excludes user/project MCP servers. Restricted
mode, disabled hooks/connectors and no Chrome are also required. These launch capabilities already have a
separate retained use in `../execution/sandbox-runner.ts`; this pilot does not use that Docker provider.
See the [upstream CLI reference](https://code.claude.com/docs/en/cli-reference). This runner-only slice does not
claim an installed CLI audit or a real account execution.

Tests use fake sessions, explicit completion gates and a fake clock. No vendor binary, account, tmux or Hub
pilot is involved. The parent feature is decision 38e2ea2d, Track A in `docs/design/hub-rooms-split.md` and
section 10 of `docs/design/hub-rooms-ux.md` on `docs/hub-ux-review-m2902`.
