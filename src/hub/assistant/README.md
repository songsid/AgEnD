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

`createClaudeAssistantHost` supplies the first adapter: one-shot Claude Code print mode with streaming JSON. Its documented `--tools ""` removes
built-in tools, and `--strict-mcp-config` with an empty MCP config excludes user/project MCP servers. Restricted
mode, safe mode, disabled hooks/connectors/skills and no Chrome are also required. Safe mode preserves subscription
authentication while skipping host customizations; bare mode is not used because it does not read subscription
credentials. These launch capabilities already have a
separate retained use in `../execution/sandbox-runner.ts`; this pilot does not use that Docker provider.
See the [upstream CLI reference](https://code.claude.com/docs/en/cli-reference), the
[safe-mode introduction in 2.1.169](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md#21169), and
[authentication in programmatic mode](https://code.claude.com/docs/en/headless). The adapter requires a stable
binary signature and a proven version of at least 2.1.316, through the host's existing disk-first/netless probe.
It does not run an unsandboxed help or version command. No installed CLI audit or real account execution is claimed.

The instance home and Fleet credential home are separate explicit options. Each launch gets a fresh empty cwd;
no credentials are copied or seeded. Named profiles use the existing credential-profile path and do not inherit
the shared account's API-key/OAuth-token environment overrides. macOS's default login keeps its unset config-dir
semantics, so the unsuffixed Keychain account remains the default account.

Output is accepted only after an empty tool/MCP initialization for the exact launch session, followed by a
successful text result from that same session. Tool-use/permission frames, malformed output, backend errors,
foreign sessions and process exits reject the turn. Stop waits for physical close before deleting its scratch
directory. This adapter is not wired into a live Fleet until the later Track A integration slice.

Every ask ends its worker's stdin and waits for process close before returning text. The next ask launches a
fresh worker with a different session and cwd. Only the room controller remains during the fifteen-minute idle
window; earlier model turns are never retained or repeatedly appended to the supplied recent context. This
one-shot refinement was accepted by Lumen at `ea4e347be`.

Tests use fake sessions, explicit completion gates and a fake clock. No vendor binary, account, tmux or Hub
pilot is involved. The parent feature is decision 38e2ea2d, Track A in `docs/design/hub-rooms-split.md` and
section 10 of `docs/design/hub-rooms-ux.md` on `docs/hub-ux-review-m2902`.

## Host administration and mount ownership

`RoomAssistantService` supplies the stable room and admin ports. Configuration is off by default, with Claude as
its first eligible backend. Only the host availability snapshot's supported tools-off version is offered; reading
the admin view never runs a CLI. A launch rechecks the binary and version using the existing disk-first/netless port.
The chosen named account is not substituted with the default account if it disappears or needs sign-in.

The host Fleet supplies a provider factory to `HubRuntime`, which calls it only while mounting the Hub server.
The same instance becomes `HubHttpDeps.roomAssistant` and `assistantAdmin`. Hub fencing immediately closes its
admission; the mount teardown owns its physical drain before any replacement. An absent factory stays disabled.
Fencing permanently retires that mounted generation: `HubMount.applyOwned` drains it before a fresh factory call;
it never resumes the fenced server in place. Re-saving unchanged assistant settings is a no-op and keeps current asks.
The rooms track owns the authenticated HTTP routes; this service slice adds no routes or visible controls.

Settings and seven UTC days of answer counters are stored atomically in the Fleet's private
`hub-assistant/assistant-state.json`, never in credential files or fleet.yaml. No room text is stored there. A failed
counter write preserves a completed answer and reports `usage-not-saved`; a settings write failure restores the
previous drained configuration. A failed physical stop keeps its owner and prevents replacement.

The default worker root is `hub-assistant/instances` under this Fleet home. Deployments may set
`AGEND_HUB_ASSISTANT_HOME` to another absolute directory without moving credentials. Each ask still gets an empty
private scratch directory and removes only that directory after its worker closes. Administration reports room
controller state, last use, seven daily counts and the selected account's coarse cached quota. It exposes no PID,
credential path or message content. The separate UI slice adds the Hub admin controls and updates the Hub skill.

Room dispatch payloads and completed answers use the real audit content store: each new content reference is bound
to its queued/answer audit record in the same transaction before any reader can consume it. Unbound content remains
unreadable. A failed turn emits `Hub room assistant could not answer` through the Hub host logger with request/room
IDs, a bounded phase and, for protocol refusals, its protocol code. Room text and raw worker errors are not logged.
Previously failed calls are not replayed after an upgrade; send a new message to try again.
