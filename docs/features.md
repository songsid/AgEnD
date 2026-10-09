# Features

## Fleet mode — one bot, many projects

Each Telegram Forum Topic maps to an independent Claude Code session. Create a topic, pick a project directory, and Claude starts working. Delete the topic, instance stops. Scale to as many projects as your machine can handle.

## Scheduled tasks

Claude can create cron-based schedules via MCP tools. Schedules survive daemon restarts (SQLite-backed).

```
User: "Every morning at 9am, check if there are any open PRs that need review"
Claude: → create_schedule(cron: "0 9 * * *", message: "Check open PRs needing review")
```

Available MCP tools: `create_schedule`, `list_schedules`, `update_schedule`, `delete_schedule`

Collaboration MCP tools: `list_instances`, `send_to_instance`, `start_instance`, `create_instance`, `delete_instance`

Schedules can target a specific instance or the same instance that created them. When a schedule triggers, the daemon pushes the message to Claude as if a user sent it.

## Crash recovery

Watches Claude's status line JSON for context usage metrics (used for dashboard and logging). All CLI backends (Claude Code, Codex, OpenCode, Kiro CLI, Antigravity CLI, Grok Build, Meta Muse Code) have built-in auto-compact that handles context limits internally — AgEnD does not trigger restarts based on context usage or session age.

When a CLI process crashes, the daemon's health check detects the dead tmux window and:

1. **Snapshot** — collects recent user messages, tool activity, and statusline data into `rotation-state.json`
2. **Process cleanup** — kills the entire process tree (CLI + MCP server) via process group signal, and kills any orphan MCP server via PID file
3. **Resume attempt** — tries `--resume` to restore the full conversation history
4. **Fallback** — if resume fails, spawns a fresh session and injects the snapshot as context
5. **Backoff** — exponential backoff on repeated crashes; 3+ crashes in a 5-minute sliding window pauses respawn

### Fleet-level circuit breaker (storm window)

When the tmux server itself dies or is replaced (not just a single window), every instance loses its window at once. The fleet treats that as one incident, a **storm window**, instead of N independent crashes:

- **Opens on the first server crash.** A death is counted once per observed alive → dead transition (or a changed server PID), not once per instance that reports it.
- **Backoff:** instance respawns are held for 30 seconds after the first crash, 2 minutes after a second, and 10 minutes from the third on. The level resets once the fleet has stayed calm for 10 minutes after the window closed.
- **Delivery is gated too:** while the window is backing off, no message is pasted into any instance; during recovery, a message to an affected instance waits until that instance has recovered.
- **Recovery:** after the backoff, instances respawn; the window closes when every affected instance has recovered, or after 10 minutes. Per-instance incident notices (crash respawn, MCP died, hang, …) are suppressed while it is open and reported as one incident.
- **`window_loss`:** when the server is fine but 4 or more instances lose their windows within 60 seconds, that is also one event (a host- or tmux-level problem). Spawning is not held, but the recoveries run at the storm rate and are reported once.

### MCP server orphan prevention

When a CLI process dies, its MCP server child process should exit too. Three layers of protection:

1. **ppid polling** (primary) — MCP server polls `process.ppid` every 5 seconds. If reparented to PID 1 (parent died), exits immediately. Works on all platforms, immune to macOS libuv/kqueue bugs.
2. **stdin EOF listeners** (secondary) — listens for stdin `end`/`close`/`error` events. Works on Linux; unreliable on macOS due to libuv CPU spin on broken pipes.
3. **PID file kill** (daemon-side) — MCP server writes its PID to `channel.mcp.pid`. On crash respawn, daemon reads the file and SIGTERMs the orphan before spawning a new CLI.

## Instance replacement

When an instance's context is polluted or it's stuck in a loop, use `replace_instance` to atomically swap it with a fresh one:

1. Collects handover context from the daemon's ring buffer (recent messages, events, tool activity)
2. Stops the old instance and preserves its config
3. Creates a new instance with the same config, reusing the Telegram topic
4. Sends handover context to the new instance via the standard message delivery path

## Instance warmup

When an instance spawns, the daemon compares the fleet instructions it just built with the ones the agent was last told about (kept in `prev-instructions` in the instance directory). **The warmup only runs when the instructions changed** — an unchanged restart sends nothing, which saves 10–30 s of agent time on every restart.

- First spawn (nothing recorded yet): the instructions are recorded and nothing is sent.
- Claude Code re-reads its instructions on resume, so it is never told.
- Every other backend gets a one-line notice to reload its own instruction file (`AGENTS.md`, kiro's agent file or steering file, `.agents/agents.md`, …). If no message is waiting, the notice is deferred to the next real message rather than provoking an unsolicited reply; if a delivery is already queued, the daemon waits for idle and pastes the notice first.

No configuration is needed.

## Instance status indicators

`agend ls` (columns Name, Backend, Status, Team, Src, Ctx, Mem, Activity) and the `/status` chat command show one state per instance. The state comes from the daemon's execution state (idle / working / stuck / paused) combined with the lifecycle (running / paused / stopped / crashed):

| State | `agend ls` | `/status` |
|---|---|---|
| Idle | green ● `Idle` | 🟢 |
| Working | blue ● `Working` | 🔵 |
| Stuck | red ● `Stuck` | 🔴 |
| Crashed | red ● `Crashed` | 🔴 |
| Paused | dim yellow ○ `Paused` | ⏸ |
| Stopped | grey ✗ `Stopped` | ✗ |

When the fleet API cannot be reached, `agend ls` falls back to `Busy` / `Idle` from pane activity. In `/status` a running instance with no execution snapshot yet shows 🟢 Running.

## Fleet /collab

Enables bot-to-bot and webhook messages in fleet topics. When `/collab` is toggled on for a topic, messages from other bots and webhooks are routed to the instance — enabling multi-bot collaboration within a single Telegram/Discord channel.

In fleet `open` mode, bot messages bypass the filter automatically (no `/collab` toggle needed).

## Cancel button

After a message is delivered to an agent, a "🛑 Cancel" button is posted in its topic or channel. Tapping it interrupts the current generation:

- **Telegram**: an inline keyboard button
- **Discord**: a button component
- **`/cancel` command**: does the same, typed or as a Discord slash command

The cancel sends the backend's own interrupt key: Ctrl+C for Kiro CLI and Grok Build, Escape for every other backend. A button is retired when the agent replies, when it is used, when a newer button replaces it, or when the instance goes idle.

Cancel also works for cross-instance messages and scheduled triggers.

The button message doubles as the progress bubble: after 30 seconds it shows how long the agent has been working and, when the backend reports it, what it is doing now.

## Delivery status

Delivery progress is shown as a reaction on the user's own message, replaced as the message moves along:

| Status | Discord (built-in) | Telegram (built-in) | Meaning |
|--------|--------------------|---------------------|---------|
| `received` | 👀 | 👀 | The fleet has the message |
| `queued` | ⏳ | 👀 | Waiting to be handed to the CLI (behind another message, or the CLI is busy or still starting) |
| `processing` | 👀 | 👀 | The agent has the message |
| `delivered` | ✅ | 👀 | The agent started on it |
| `failed` | ❌ | 👎 | Delivery failed (for example the window was gone and retries ran out) |

Telegram only accepts a fixed set of reactions, and ⏳, ✅ and ❌ are not in it, which is why its built-ins differ.

The emojis are configurable per channel and per instance with `status_emojis` (see [configuration](configuration.md#channeloptionsstatus_emojis-discord-and-telegram)), including `photo` and `attachment`, the stamps a ClassicBot puts on a photo or file it saved.

### Persona emoji

In a channel with several bots, each agent can pick an emoji that stands for it, so people can see who handled a message. Three MCP tools do this, and the bundled `persona-emoji` skill walks an agent through them:

- `list_emojis` — the emojis this instance may use: the platform's standard set and, on Discord, the server emojis its bot can react with. Server emojis come as values only (no image URLs unless `with_image_urls`), and can be narrowed with `name` (a substring), `limit` (across all servers) and `primary_only` — on a busy server the full list was ~10k characters for an agent that wanted one emoji.
- `preview_emojis` — downloads up to 8 server emojis and returns a local image path for each, so the agent can look before it picks. The fleet builds the image address from the emoji id itself and keeps only small PNGs.
- `set_persona_emoji` — sets the instance's own `delivered` stamp (or another status it names), checked the same way Settings checks it.

Every tool profile can list and preview. Every profile except `minimal` can also set its own stamp (`general` since 2.1.9). ClassicBot instances can list and preview, but setting a stamp is done in Settings. The tools only ever change the calling instance's own entry.

### Stickers

Agents can send stickers on Discord and Telegram (2.1.12). The tools look the same on both platforms; underneath, each platform works its own way:

- `list_stickers` — the stickers this instance can send where it talks, each as `{ id, name, emoji_or_tags, format }`, with no image URLs. **Discord:** the stickers of the server the instance's own channel is in — a bot cannot send another server's stickers, so they are not listed (Discord's standard sticker packs are not listed either). **Telegram:** stickers live in sticker sets that can be used in any chat, so the call names a `set` (the `<name>` in `t.me/addstickers/<name>`), or lists the connection's [`options.sticker_sets`](configuration.md#channeloptions-telegram). `name` and `limit` narrow the list.
- `preview_stickers` — downloads up to 8 stickers from `list_stickers` and returns a local image path for each to Read. Only stickers `list_stickers` returned can be previewed. A Discord Lottie sticker, or an animated Telegram sticker without a thumbnail, has no still picture and is listed as `preview_unavailable`. On Telegram the download happens inside the adapter, so the bot token in the file URL never leaves it.
- **Sending:** `reply` takes `stickers` (up to 3 ids from `list_stickers`); `text` may then be omitted. **Discord** sends them on the same message as the text (its last chunk, for a long text). **Telegram** sends the text first, then one sticker after another. A sticker is checked before anything is sent: on Discord it must be an available sticker of the server the reply goes to, so another server's sticker is refused with an error instead of a reply that silently arrives without it. Stickers are never written in the text — an id in the text is just text.
- `agend-agent stickers [set] [--name …] [--limit …]`, `agend-agent sticker-preview <id…>` and `agend-agent reply <text> --sticker <id>` do the same from the CLI.

Uploading stickers or creating sticker sets is not supported.

## Tool progress (`tool_progress`)

`tool_progress` adds the agent's tool activity to the progress bubble, as a running list for the turn:

| Value | Shows |
|---|---|
| `off` (default) | Nothing beyond the elapsed time |
| `standard` | Semantic labels (for example `npm test` shows as `🧪 執行測試`, "run tests"), never shell arguments |
| `verbose` | The same labels plus a truncated command preview |

It is opt-in because the bubble broadcasts activity into the channel; credentials (API keys, tokens, bearer headers, `password=` assignments, …) are redacted before anything is posted. When the bubble is retired, the list stays behind as a read-only tool history. Set it per instance, in `defaults`, or per ClassicBot channel.

## Reply completion guard (`reply_completion_guard`)

A human message has to be answered through the `reply` (or `react`) tool; text the agent only prints in its terminal never reaches the chat. On Claude Code, the reply completion guard notices a human-facing turn that ended without a delivered reply:

- It waits until the instance has actually worked on the turn and then stayed idle for 60 seconds, so a pause mid-turn is not mistaken for the end.
- It then asks the agent, once, to send its conclusion with `reply` or `react` — without redoing the work.
- If a reply was attempted but its result is unknown (it may have been applied and then timed out), it does not retry, so you never get the answer twice; a short notice in the chat says the reply could not be confirmed.

It is on by default (`reply_completion_guard: true`); set `false` per instance, in `defaults`, or per ClassicBot channel to turn it off. Other backends do not have it.

## Peer-to-peer agent collaboration

Every instance is an equal peer that can discover, wake, create, and message other instances. No dispatcher needed — collaboration emerges from the tools available to each agent.

**Core MCP tools:**

- `list_instances` — discover all configured instances (running or stopped) with status, working directory, and last activity
- `send_to_instance` — send a message to another instance or external session; supports structured metadata (`request_kind`, `requires_reply`, `correlation_id`, `task_summary`)
- `start_instance` — wake a stopped instance so you can message it
- `create_instance` — create a new instance with a topic (directory optional; auto-created at `~/.agend/workspaces/<name>` if omitted); supports `branch` for git worktree isolation
- `delete_instance` — remove an instance and its topic
- `replace_instance` — replace an instance with a fresh one (handover + delete + create)
- `describe_instance` — get detailed info about a specific instance (description, model, last activity)
- `set_display_name` — set the name shown in messages, activity logs and other agents' views
- `set_description` — set the role description injected into the agent's system prompt; it takes effect on the next session restart

**High-level collaboration tools** (prefer these over raw `send_to_instance`):

- `request_information` — ask another instance a question and expect a reply (`request_kind=query`, `requires_reply=true`)
- `delegate_task` — assign work to another instance with success criteria (`request_kind=task`, `requires_reply=true`)
- `report_result` — return results to the requester, echoing `correlation_id` to link the response to its request

**Team tools** (target groups of instances):

- `create_team` — define a named group of instances
- `list_teams` — list all teams with member details
- `update_team` — add/remove members or update description
- `delete_team` — remove a team definition
- `broadcast(team: "name", ...)` — send a message to all members of a team

When an instance sends to another, a notification appears in the target's topic: `sender → receiver: summary`. General Topic instances are excluded from these notifications to reduce noise.

If you `send_to_instance` a stopped instance, the error tells you to use `start_instance()` first — agents self-correct without human intervention.

### Delivery tracking (`delivery_status`)

A cross-instance send returns as soon as the fleet has accepted it (`{ sent, queued }`, with an `operation_id` / `delivery_id`); the fleet owns delivery from there, through a durable outbox. `delivery_status` reads where a delivery got to, by exactly one of `delivery_id`, `operation_id`, `correlation_id` or `message_id` (paged with `limit` up to 100 and `cursor`). A row moves through `queued`, `delivering`, `submission_started`, `reconciliation_pending`, `retry_wait` to `delivered`, `failed`, `uncertain` or `cancelled`. `uncertain` means it may have arrived: do not resend blindly.

Each row also says how it was routed and what became of it after it reached the CLI (#1201):
- `delivery_mode` is `steer` (into the live turn) or `idle_queue` (as the next message), as `send_to_instance` reported it.
- `submission_mode` is how the latest attempt was written: `idle_submit`, `steer`, `native_queue_handoff` (into a busy CLI's own queue) or `raw_paste`.
- `consumed_at` / `consumed_via`: a steer or a native-queue hand-off is accepted into the CLI's input long before the model reads it. Claude Code takes it at the next tool boundary or when the turn ends. When the CLI's transcript (claude-code, codex) shows the delivery's own marker taken, the row records when, and whether it came as its own turn (`turn`) or inside the running one (`mid_turn`). That is also the one thing that turns an `uncertain` row into `delivered`; a failure notice not yet sent to the sender is then withdrawn. No match never changes a row.

An instance only sees rows it sent or received (its identity comes from its own socket or token, never from an argument). Looking up an inbound message's `message_id` is how an agent checks that a peer message really came through the fleet: "Delivery not found" means it did not. Every tool profile has `delivery_status`, `minimal` included.

### `awaiting_input`

`list_instances` and `describe_instance` report an `instance_state`. Besides the execution states (`idle`, `working`, `stuck`, `paused`) it can be `awaiting_input`: the CLI is showing a prompt that waits for a person — a permission request, a dangerous-command confirmation, a login screen or another dialog — and the observation is fresh (under 15 seconds old) and confirmed rather than suspected. The separate `execution_state`, `interaction` and `interaction_summary` fields carry the detail. It is presentation only: it never feeds the fleet's own state or its gates.

### Fleet context system prompt

On startup, each instance automatically receives a fleet context system prompt that tells it:

- Its own identity (`instanceName`) and working directory
- The full list of fleet tools and how to use them
- Collaboration rules: how to handle `from_instance` messages, when to echo `correlation_id`, scope awareness (never assume direct file access to another instance's repo)

This means instances understand their role in the fleet from the first message, without any manual configuration.

## Task board

A fleet-wide task list, kept in the fleet's SQLite database, through one `task` tool:

- `task(action: "create")` — a new task with `title`, optional `description`, `priority` (`low` / `normal` / `high` / `urgent`), `assignee` and `depends_on` (task IDs).
- `task(action: "claim")` — assign an `open` task to yourself. A task whose dependencies are not all `done` cannot be claimed.
- `task(action: "done")` — mark a task you claimed as done, with an optional `result`. Only a `claimed` task can be completed.
- `task(action: "update")` — change `status` (`open` / `claimed` / `done` / `blocked` / `cancelled`), `priority`, `assignee` or `result`.
- `task(action: "list")` — every task, most urgent first; narrow it with `filter_assignee` and `filter_status`.

Creating, claiming and completing a task are written to the activity log. Every tool profile except `minimal` has `task`.

## Decisions

Decisions are rules and conventions that outlive a conversation. `post_decision` records one with a `title` and `content`, optional `tags`, a `ttl_days` after which it is archived (default: permanent), and `supersedes` to replace an older one. `scope: "project"` (the default) makes it visible to instances working in the same directory; `scope: "fleet"` to every instance. `list_decisions` returns the active ones (`include_archived`, `tags` to filter), and `update_decision` changes or archives one — a coordinator verb, since it edits what somebody else recorded.

Active decisions are injected into each instance's instructions at spawn. A fleet-scoped decision still has to be relevant: global (no project), or from the same project or one of its worktrees/checkouts. General instances get every fleet-scoped decision, since they route work across projects.

## Repo checkout (`checkout_repo`)

`checkout_repo(source, branch?)` mounts another repository as a detached git worktree under the instance's own directory (`<instance dir>/repos/<repo>-<branch>`) and returns its `path`, `branch`, `source` and short `commit`, so an agent can read another project without touching that instance's working tree (it is a separate worktree; nothing enforces read-only). `source` must be an absolute or `~`-prefixed path to a git repository (use `describe_instance` to find a repo's `working_directory`); `branch` defaults to `HEAD` and must be a plain ref name. `release_repo(path)` removes a worktree created this way, and only one under the instance's `repos/` directory. Both are worker tools.

## General Topic instance

A regular instance bound to the Telegram General Topic. Auto-created on fleet startup, it serves as a natural language entry point for tasks that don't belong to a specific project. Its behavior is defined entirely by its project's `CLAUDE.md`:

- Simple tasks (web search, translation, general questions) — handles directly
- Project-specific tasks — uses `list_instances()` to find the right agent, `start_instance()` if needed, then `send_to_instance()` to delegate
- New project requests — uses `create_instance()` to set up a new agent

Use `/status` in the General topic for a fleet overview. All other project management is handled by the General instance through natural language.

## External session support

You can connect a local Claude Code session to the daemon's channel tools (reply, send_to_instance, etc.) by pointing `.mcp.json` at an instance's IPC socket:

```json
{
  "mcpServers": {
    "agend": {
      "command": "node",
      "args": ["path/to/dist/channel/mcp-server.js"],
      "env": {
        "AGEND_SOCKET_PATH": "~/.agend/instances/<name>/channel.sock"
      }
    }
  }
}
```

The daemon automatically isolates external sessions from internal ones using env var layering:

| Session type | Identity source | Example |
|---|---|---|
| Internal (daemon-managed) | `AGEND_INSTANCE_NAME` via tmux env | `ccplugin` |
| External (custom name) | `AGEND_SESSION_NAME` in `.mcp.json` env | `dev` |
| External (zero-config) | `external-<basename(cwd)>-<pid>` fallback | `external-myproject-48213` |

Internal sessions get `AGEND_INSTANCE_NAME` injected by the daemon into the tmux shell environment. External sessions don't have this, so they fall through to `AGEND_SESSION_NAME` (if set) or an auto-generated name from the working directory plus the MCP server's PID, so two sessions in the same project do not collide. This means the same `.mcp.json` produces different identities for internal vs external sessions — no configuration conflicts.

External sessions appear in `list_instances` and can be targeted by `send_to_instance`.

## Tool profiles

What an agent may do is decided per instance by `tool_set`, and enforced by the
fleet rather than by what the model was shown. Three profiles matter:

| profile | how you get it | what it is |
|---|---|---|
| `worker` | **the default** | Talk to people and to peers, read the fleet, do the work. `reply`, `send_to_instance`, `broadcast`, `report_result`, `request_information`, `delegate_task`, `delivery_status`, `task`, `post_decision`, `checkout_repo` / `release_repo`, and every read-only query — including `list_schedules` and `list_deployments`, so it can see what exists without being able to change it. Since 2.1.6 it may also create and change schedules that target itself (#896), and it can list, preview and set its own persona emoji and list and preview stickers. 38 tools. |
| `coordinator` | `tool_set: coordinator` | Everything a worker has, plus the verbs that run the fleet: create/delete/replace/start/stop/restart/wake instances, deploy and tear down templates, team CRUD, creating and changing schedules, `update_instance_config`, `update_fleet_defaults`, `update_decision`. |
| `full` | `tool_set: full` | Every tool AgEnD has. |

**`coordinator` and `full` are the same 54 tools today** — the difference is what
they mean, not what they contain. `coordinator` says "this agent runs the fleet",
and will be narrowed if a verb turns out not to belong there; `full` says "give
this one everything regardless", and is the name the old default had. If you want
an agent to coordinate, write `coordinator` — reaching for `full` to get *more*
gets you nothing extra and opts you out of every future refinement.

`standard` (29 tools) and `minimal` (9) still exist. `minimal` gained `list_emojis` and `preview_emojis` in 2.1.9, and `list_stickers` and `preview_stickers` in 2.1.12.
**`general` is an identity, not a profile you can pick**: it is assigned to
instances with `general_topic: true`, and writing it by hand fails validation —
two ways of being a General would eventually disagree.

`delegate_task` is deliberately a worker tool. It creates nothing, destroys
nothing, and needs a target that already exists, so an ordinary agent can hand
work to a peer without being able to spawn one.

### Why the fleet decides, not the tool list

A narrowed profile used to mean the model was shown fewer tools, which is not
the same as being unable to use them. There are four ways to reach a fleet tool
and only one of them ever consulted the list: naming a tool directly in a
`tools/call` worked, writing to the instance's own socket bypassed the MCP
server entirely, and `POST /agent` checked *which* instance was calling but
never whether it was allowed. Permission is now answered where those paths
converge, so the profile is a boundary rather than a suggestion.

A refused call explains itself — the tool, the profile the instance runs under,
and the two ways forward (report what you need, or be marked `coordinator`) —
because the agent reads that error as its next instruction.

### Marking a coordinator

```yaml
instances:
  team-lead:
    working_directory: /home/you/projects/app
    tool_set: coordinator
```

On the first start after upgrading, AgEnD reads the last thirty days of activity
and names the instances that have actually used a tool a worker no longer gets,
with the counts. It never edits your config: which agents coordinate is a
statement about how your fleet is organised, and an explicit `tool_set: full`
stays exactly as you wrote it.

**Today this can only be set through Settings or by editing `fleet.yaml`** —
General's `update_instance_config` has no `tool_set` field yet, so a value sent
that way is dropped.

## Permission system

Uses Claude Code's native permission relay — permission requests are forwarded to Telegram as inline buttons (Allow/Deny). When Claude requests a sensitive tool use, the daemon surfaces it to you in Telegram and waits for your response before proceeding.

Permission prompts show a countdown timer that updates every 30 seconds. An "Always Allow" button lets you approve all future uses of a specific tool for the current session. Decisions are shown inline after you respond ("✅ Approved" / "❌ Denied").

## Voice transcription

Telegram voice messages are transcribed via Groq Whisper API and sent to Claude as text. Works in both topic mode and DM mode. Requires `GROQ_API_KEY` in `.env`.

## Dynamic instance management

Instances are created through the General instance using `create_instance` —
which is a coordinator tool, so an ordinary worker cannot create one (see
[Tool profiles](#tool-profiles)).  Tell the General instance what project you want to work on — it creates a Telegram topic, binds the project directory, and starts Claude automatically. Instances can also be created with `--branch` to spawn a git worktree for feature branch isolation. Deleting a topic auto-unbinds and stops the instance. Use `delete_instance` to fully remove an instance and its topic.

## Cost guard

Prevent bill shock when running unattended. Configure daily spending limits in `fleet.yaml`:

```yaml
defaults:
  cost_guard:
    daily_limit_usd: 50
    warn_at_percentage: 80
    timezone: "Asia/Taipei"
```

When an instance approaches the limit, a warning is posted to its Telegram topic. When the limit is reached, the instance is automatically paused and a notification is sent. Paused instances resume the next day or when manually restarted.

## Fleet status

Use `/status` in the General topic to see a live overview. It is a table with one row per instance:

```
| Instance | Backend | Model | Ctx | Effort | Cost | State |
```

State combines paused, stopped or crashed with the execution state (see [Instance status indicators](#instance-status-indicators)), and Model is the live model, the same one `/ctx` reports. `/status` is for fleet admins. (The IPC column was removed in 2.1.9.)

## Diagnostics and per-agent chat commands

Besides `/status`, these work from chat (on Discord as slash commands; on Telegram the fleet-wide ones are answered in the General topic). See [commands](commands.md) for who may use each.

- **`/usage`** (anyone) — AI subscription usage for the CLIs logged in on this machine: Claude, Codex, Muse, Grok, Kiro and Antigravity. A backend with [credential profiles](#credential-profiles-and-a-second-subscription) gets one row per subscription. Agents read the same data with `get_usage`.
- **`/doctor`** (fleet admin) — health diagnostics in six sections: Prerequisites, Service, Fleet, Channel gateways, MCP IPC and Resources, each check `ok`, `warn` or `error`.
- **`/sysinfo`** (anyone) — fleet uptime and memory, instance counts, system memory, and each backend CLI's version.
- **`/model`** (channel admin) — switch the instance's model from a menu (on Telegram also `/model <name>`).
- **`/effort`** (channel admin) — set the reasoning effort (`low` / `medium` / `high` / `xhigh` / `max`, clamped to what the backend accepts). Claude Code, Grok, Antigravity and Muse change it at runtime; Kiro CLI and Codex restart the instance to apply it; OpenCode has no effort setting. Agents read it with `get_effort`.

## Daily summary

A daily report is posted to the General topic at a configurable time (default 21:00):

```
📊 Daily Report — 2026-03-26

proj-a: $8.20, 2 restarts
proj-b: $2.10
proj-c: $0.00 ⚠️ 1 hang

Total: $10.30
```

## Hang detection

If an instance shows no activity for 15 minutes (configurable), the daemon posts a notification with inline buttons:

- **Force restart** — stops and restarts the instance
- **Keep waiting** — dismisses the alert

Uses multi-signal detection: checks both transcript activity and statusline freshness to avoid false positives during long-running tool calls.

## Rate limit-aware scheduling

When the target's 5-hour usage is over 85%, a scheduled trigger is deferred instead of firing, and the instance's topic says so. A reading whose window has already reset no longer counts: claude-code rewrites its statusline only when it renders, so an idle instance can show 100% long after the reset.

A deferred run is retried **once**, after the window resets:
- **When it runs.** At the reset time from the statusline (plus a minute). If the statusline gives no reset time, the retry checks every 15 minutes and runs at the first check below the threshold.
- **What the agent sees.** The retry keeps the run's id, and its message starts with `[retry] originally due 21:00 (Asia/Taipei), deferred by the 5h rate limit at 100%`. A silent schedule pastes its raw command unchanged.
- **Never twice.** A retry never runs at or after the schedule's next regular run, or after 5h15m. If the next run, a catch-up or a manual trigger comes first, the retry is dropped.
- **Across restarts.** A pending retry survives a fleet restart.
- **`last_status`.** It shows `deferred → delivered (retry)`, or `deferred → skipped (superseded | deferred again | expired)`.
- **When it can't run.** If the retry is superseded, deferred again after the reset, or never gets a reset in time, the schedule's chat says so and @mentions that world's admins (the channel's `access.allowed_users`).

## Model failover

When the primary model hits a rate limit, the daemon automatically switches to a backup model on the next session restart. Configure a fallback chain in `fleet.yaml`:

```yaml
instances:
  my-project:
    model_failover: ["opus", "sonnet"]
```

The daemon notifies you in Telegram when a failover occurs and switches back to the primary model when rate limits recover.

## Graceful restart

`agend fleet restart` sends SIGUSR2 to the fleet manager. It waits for all instances to go idle (no transcript activity for 10s), then restarts them one by one. A 5-minute timeout prevents hanging on stuck instances.

## Topic icon + idle archive

Running instances get a visual icon indicator in Telegram. When an instance stops or crashes, the icon changes. Idle instances are automatically archived — sending a message to an archived topic re-opens it automatically.

## Daemon-side restart snapshot

Before each context restart, the daemon saves a `rotation-state.json` with recent user messages, tool activity, context usage, and statusline data. The next session receives this snapshot in its system prompt, providing continuity without relying on Claude to write a handover report.

## Service message filter

Telegram system events (topic rename, pin, member join, etc.) are filtered out before reaching Claude, saving context window tokens.

## Health endpoint

An HTTP endpoint for external monitoring tools, on the fleet's web server:

```
GET /health  → { status, uptime, instances: { configured, running, crashed, paused, stopped },
                 adapters: { total, connected, states, details }, startupComplete,
                 memory, hostMemory, problems: [ ... ] }
GET /status  → { instances: [{ name, status, context_pct, cost }] }
```

`/health` needs no token. Its `status` is:

- `ok` — every check passed: at least one channel adapter connected, nothing crashed, startup complete (and, on Linux, no host memory pressure);
- `degraded` — reachable, but something needs a look (an adapter retrying, a crashed instance, startup not finished, memory pressure); `problems` says what;
- `down` — adapters are configured and none is connected, so no message can arrive or be answered.

Anything but `ok` answers **HTTP 503**, so a plain HTTP monitor sees it. (It used to answer 200 `ok` with a count of configured instances whatever their state.)

`/status` needs the web token (the `X-Agend-Token` header or the dashboard session cookie). `cost` is the instance's `cost.total_cost_usd` from its statusline (Claude Code writes one; other backends report 0).

Configure in `fleet.yaml`:

```yaml
health_port: 19280  # top-level, default 19280, binds to 127.0.0.1
```

## Webhook notifications

Push fleet events to external endpoints (Slack, custom dashboards, etc.):

```yaml
defaults:
  webhooks:
    - url: https://hooks.slack.com/...
      events: ["restart", "hang", "cost_warn"]
    - url: https://custom.endpoint/ccd
      events: ["*"]
```

## Discord adapter

Connect your fleet to Discord instead of (or alongside) Telegram.

### What it supports

- **Topic mode**: one text channel per instance under an "AgEnD Agents" category (rename with `options.category_name`), plus a General channel.
- **ClassicBot**: `/start` in any text channel turns it into an agent channel; `/stop` removes it. Collab mode (on by default after `/start`) triggers the agent only when the bot is @-mentioned.
- **Several bots in one server**: each bot is its own `channels[]` entry; a bot answers only messages that mention it and never answers for another bot.
- **Slash commands**: 25, including `/chat`, `/steer`, `/btw`, `/cancel`, `/ctx`, `/compact`, `/model`, `/effort`, `/dashboard`, `/usage`, `/login`; the ones that need an admin are marked 🔒 (the mark is generated from the same table that enforces it).
- **Buttons and menus**: permission approval (Allow / Always / Deny), backend picker, cancel, and hang / model / effort pickers.
- **Reactions**: reactions on the bot's messages (including other bots') reach the agent; delivery-status stamps are configurable per instance or channel; persona emoji can use server emoji.
- **Attachments**: images, files and audio are downloaded; forwarded messages keep their images; replying to an image includes it.
- **Long messages** are split at 2000 characters without breaking code fences; long slash-command replies use embeds.
- **Resilience**: a gateway watchdog reconnects a stale connection, and the shared send queue backs off on rate limits.

### Setup

Discord support is built into the core package — no extra install needed.

1. **Create a Discord bot** at [Discord Developer Portal](https://discord.com/developers/applications):
   - Create a new Application → Bot
   - Enable **Privileged Gateway Intents**: Presence Intent, Server Members Intent, Message Content Intent
   - Generate an invite URL with `bot` scope and `Send Messages`, `Read Message History`, `Manage Channels` permissions
   - Invite the bot to your server

2. **Run the quickstart** (or the 9-step `agend init`; both ask Telegram or Discord):
   ```bash
   agend quickstart    # Select "Discord" when prompted
   ```

3. **Or configure manually** in `fleet.yaml`:
   ```yaml
   channel:
     type: discord
     mode: topic           # Optional — topic is the default
     bot_token_env: AGEND_DISCORD_TOKEN
     group_id: "123456789012345678"   # Quote Discord snowflake IDs to prevent precision loss
     access:
       mode: locked
       allowed_users:
         - "your_discord_user_id"     # Also quote user IDs
   ```

4. **Set the bot token** in `~/.agend/.env`:
   ```
   AGEND_DISCORD_TOKEN=your_bot_token_here
   ```

### Troubleshooting

- **Messages are empty:** Enable **Message Content Intent** in Discord Developer Portal → Bot → Privileged Gateway Intents.
- **ID precision loss:** Always quote Discord IDs (guild ID, user ID) in YAML — they are 64-bit snowflakes that exceed JavaScript integer precision.
- **Slow startup with MCP:** If backend CLI times out during startup due to MCP server connections, increase the timeout in `fleet.yaml`:
  ```yaml
  defaults:
    startup_timeout_ms: 60000   # Default: 25000 (25s)
  ```
- **`registerBotCommands` ETIMEDOUT:** This is non-fatal — bot polling starts regardless. Occurs on unstable networks.
- **`working_directory` not found:** Directories are auto-created since v1.19. If you see this error, update to the latest version.

## External adapter plugin system

Community adapters can be installed via npm and loaded automatically:

```bash
npm install agend-plugin-slack
```

For a `channel.type` that is not built in, the daemon does not scan for adapters: it tries to import, in order, `@songsid/agend-plugin-<type>`, `@suzuke/agend-plugin-<type>`, `agend-plugin-<type>`, `agend-adapter-<type>`, then the bare `<type>` (`src/channel/factory.ts`). Channel types are exported from the package entry point for adapter authors.

## Kiro CLI backend

Backend for AWS Kiro CLI (`backend: kiro-cli`). Supports session resume, MCP config, and models: `auto`, `claude-sonnet-4.5`, `claude-haiku-4.5`. Configure in `fleet.yaml` like any other backend.

### Startup resilience (kiro)

Kiro's `--resume` needs a round trip to its backend before it paints anything, so a slow or unreachable `runtime.*.kiro.dev` used to look like a dead CLI. Since v2.1.4 the daemon:

- gives a kiro **resume** launch a 60s startup budget (a fresh prompt keeps the 25s default; a larger `startup_timeout_ms` is never lowered);
- retries resume **once** before clearing the session, so a slow backend no longer costs the conversation (at most 2 resume attempts + 1 fresh);
- recognises kiro's `dispatch failure (timeout) … kiro.dev` output as a **fleet-wide backend outage**: one General-topic notice per outage instead of one per instance, and while it lasts a failed resume keeps its session and fails the startup instead of starting fresh;
- **retries failed startups automatically** after 1, 5 and 15 minutes (continuing every 15 minutes, up to 6 attempts, while the backend is down), through the spawn gate and never during a tmux storm. One aggregated "N instances failed to start" notice and, if it comes to that, one "gave up" notice. An `agend start`/`/restart` supersedes the pending retry.

The resume budget, resume retry and outage short-circuit are kiro-only (they are backend capabilities). The delayed automatic startup retry applies to **every** backend and every unattended start path (fleet startup incl. General, full restart, config reconcile): a failed start that stayed `stopped` forever was never kiro-specific. Explicit `agend start` / API starts still report their error synchronously. An auto-paused kiro instance's wake uses the same 60s resume budget.

### UI and engine pinning (`kiro_ui`, `kiro_engine_status`)

`kiro_ui` picks how a kiro instance is launched: `legacy` (the default) runs kiro's legacy UI on its v1 agent engine (`--legacy-ui --agent-engine=v1`), `tui` its terminal UI on the v2 engine (`--tui --agent-engine=v2`). Both are pinned on every launch, so a kiro-cli default or saved setting cannot move an instance to another engine — its conversation would not come along. When the installed kiro-cli can no longer run what an instance is pinned to, AgEnD refuses to start it and says why rather than letting kiro pick (#1109). `kiro_ui: v3` is refused by validation until kiro's v3 interface can run unattended (#849).

`kiro_engine_status` (a read-only tool every profile except `minimal` has) shows, for each kiro instance and ClassicBot channel, its `kiro_ui`, the engine flags its next launch would use or why kiro-cli would refuse it, its recorded launches (kiro-cli and AgEnD versions per change), its V3 session and its credential profile. It reads what AgEnD recorded at the last launch and never runs kiro-cli itself.

## agend quickstart

Simplified 4-question setup wizard for new users. Auto-detects installed backends, auto-discovers Telegram group ID via `getUpdates` polling, and generates a minimal `fleet.yaml` with sensible defaults. Replaces the 9-step `agend init` as the recommended onboarding path.

## Web Dashboard

The fleet serves a web dashboard on `127.0.0.1` (`health_port`, default 19280). Its `/ui` is **web chat**: pick an instance and talk to it from the browser. It is the same conversation as that instance's Telegram or Discord chat: what you send from the web is echoed into the topic as `🌐 web-user: …`, and the agent's replies show in both. Files and images (📎, paste or drop), Stop, and ticks showing how far each message got all work there, and a fleet with no chat platform can be run from the dashboard alone. `/view` is the read-mostly overview and `/settings` the fleet settings.

Sign in with a one-time code: send `/dashboard` (fleet admin) or run `agend web` on the host. To use it from a phone or another computer, see [Reaching it from elsewhere](web-dashboard.md#reaching-it-from-elsewhere). The full guide is [web-dashboard.md](web-dashboard.md).

## Remote CLI sign-in (`/login`)

`/login [backend]` (fleet admin; Telegram General topic, or Discord) signs a backend CLI in — and installs it first when it is missing — without SSH. With no argument it shows a picker of every installed or installable backend. Each login runs in a temporary tmux window of its own (instance panes are untouched), times out after 10 minutes, and can be stopped with `/login cancel`.

- **Device code** — `codex` and `grok`: the URL and code are posted in the chat.
- **Browser terminal** — `claude-code` and `kiro-cli`: AgEnD opens a one-time web terminal on the login command where you finish the sign-in (and paste a code back). The link works on this machine by default (SSH forwarding, tailscale, your own proxy).
- **Install only** — `opencode` and `muse` have no sign-in flow here. Remote sign-in for `antigravity` is declined, because `agy` has no separate login command.

**Public link.** For a phone that cannot reach the machine, a `claude-code` or `kiro-cli` login offers a temporary public https link through a Cloudflare Quick Tunnel: the confirmation has **I understand (temporary public link)**, **I understand (local network)** and **Cancel**, and the first button is the consent, once per login. A `cloudflared` on `PATH` is used if there is one; otherwise AgEnD downloads Cloudflare's build into `~/.agend/bin/` once, pinned and checked against a SHA256 it ships with. The link and the access token are sent to you as two private messages, never in the channel, and the tunnel is stopped when the login ends in any way. Cloudflare terminates TLS, so it can see that terminal. `web_terminal.tunnel.allow_public: false` turns the option off for the host. Details: [configuration](configuration.md#finishing-a-login-away-from-the-machine-public-link).

After a successful login, the backend's running instances are restarted to pick up the new credential. `/install-cli` is a leftover typed alias: it still works, says it moved, and runs `/login` with the same argument; it is in no command menu.

## Credential profiles and a second subscription

A CLI keeps its login in one place, so by default every instance of a backend shares one account. `credential_profile` gives an instance a named, separate login for **`kiro-cli`** and **`codex`**:

```yaml
instances:
  work-agent:
    backend: kiro-cli
    backend_options:
      kiro-cli:
        credential_profile: work
```

Profiles live in `~/.agend/credential-profiles/<backend>/<profile>`, under the fleet, so several agents can point at one subscription. An instance without a profile is unaffected. Only the login is separated: kiro's large runtime caches are linked back to the shared copy, and for Codex only `auth.json` differs. Switching profiles is a config change plus a restart (`update_instance_config` does both); switching to a profile that was never logged in is refused with the command to log it in. On kiro a switch starts a new conversation, because kiro keeps conversations in the same store as its login (AgEnD hands the recent context over); on Codex the conversation stays.

**ClassicBot channels (#1220).** A channel in `classicBot.yaml` takes the same `backend_options.<backend>.credential_profile`, over any profile inherited from the fleet defaults (an empty or `null` value means the shared login). Its agent launches on that profile, `/usage` counts it under that subscription's row (for example `Codex (personal)`), and `kiro_engine_status` reports it. An unusable profile name stops that channel's agent from starting rather than running it on another login. Changing the profile restarts the channel's agent.

`/usage`, `get_usage` and the dashboard show one row per subscription, never added together. Full reference: [configuration](configuration.md#credential-profiles-multiple-subscriptions-of-one-backend).

## Built-in workflow template

Fleet collaboration workflow is auto-injected via MCP instructions. The `workflow` field in `fleet.yaml` controls this:

- `"builtin"` (default) — standard collaboration workflow
- `"file:./path.md"` — custom workflow from file
- `false` — disable workflow injection

## Workflow layering: coordinator vs executor

The General instance receives the full coordinator playbook (choosing collaborators, task sizing, delegation principles, goal & decision management). Other instances get a slimmed executor workflow (communication rules, progress tracking, context protection). This ensures the General instance acts as an intelligent dispatcher while worker instances stay focused.

## Crash-aware snapshot restore

Context snapshots are now written on crash detection, not just on context rotation. The snapshot file persists on disk with an in-memory consumption flag, enabling recovery even after daemon restarts. Agents resume with context after unexpected crashes, not just planned rotations.

## Error monitor hash dedup

The PTY error monitor records the pane content hash at recovery time. If the same error appears on the same screen, it is suppressed to prevent stale re-detection loops. This eliminates false positive error notifications from persistent terminal output.

## Parallel startup

Fleet instances now start in parallel instead of sequentially. Includes handling for tmux duplicate session race conditions that can occur when many instances spawn simultaneously.

## Fleet ready notification

After `fleet start` or `fleet restart`, a "Fleet ready. N/M instances running." message is posted to the General topic. If any instances failed to start, they are listed in the notification.

## create_instance systemPrompt parameter

Agents can pass custom system prompts when creating instances via the `systemPrompt` parameter. Supports inline text. The prompt is injected via MCP instructions alongside the fleet context.

## project_roots enforcement on create_instance

When `project_roots` is configured in `fleet.yaml`, `create_instance` validates that the requested working directory falls under one of the configured roots. Requests for directories outside the boundary are rejected with an error.

## reply_to_text injection

When a user replies to a previous message in Telegram, the quoted text is included in the formatted message delivered to the agent. This gives agents context about what the user is referring to.

## delete_instance team cleanup

When an instance is deleted via `delete_instance`, it is automatically removed from all teams it belongs to. No manual team membership cleanup is needed.

## HTML Chat Export

`agend export-chat` exports fleet activity as a self-contained HTML file. Supports `--from` and `--to` date filters and `-o` for output path. The exported file includes all messages, tool calls, and cross-instance communications in a readable chat format.

## Bot-to-bot message visibility

When one instance sends another a message (`send_to_instance`, `delegate_task`, `report_result`, …), AgEnD also posts it in the instance topics so people can follow along: the whole message in the sender's topic, and in the target's topic the whole message for a task or query, a short summary for any other kind, nothing for a report or update. In a busy fleet that can bury the conversation with people. `cross_instance_visibility` sets how much is posted (#1302):

| Mode | Instance topics |
|------|-----------------|
| `full` (default) | As described above — unchanged from earlier versions |
| `summary` | The same posts, each one line: `sender → target: ` plus the sender's task summary, or the opening of the message |
| `hidden` | Nothing |

Each topic follows its own instance: `instances.<name>.cross_instance_visibility`, else `defaults.cross_instance_visibility`, else `full`. A fleet admin sets the fleet default with `/visibility full|summary|hidden` (Telegram General topic, or Discord), which saves it to `fleet.yaml`; `/visibility` alone shows the current setting and the instances that have their own. Settings has the fleet default (Defaults) and a per-agent override (agent → Advanced). A change applies at once, with no restart.

Only these topic posts change. Messages are delivered exactly as before, the [Mirror Topic](#mirror-topic) still receives every message, and General topics never show these posts in any mode.

## Mirror Topic

Configure `mirror_topic_id` in `fleet.yaml` to designate a Telegram topic for observing cross-instance communication. All `send_to_instance` messages are mirrored to this topic in real time. This is a daemon-level hook with zero changes to agent behavior — agents don't know they're being observed.

## Codex session resume

Each Codex instance resumes **its own** conversation. At launch AgEnD reads Codex's shared session database (`~/.codex/state_5.sqlite`) read-only and picks the newest interactive session whose recorded working directory is exactly the instance's, then runs `codex resume <id>`. It does not use `codex resume --last`: since Codex 0.157 that picks the newest session of the whole git repository, so instances on worktrees of one repo would take each other's sessions (#984).

| Situation | Launch |
|---|---|
| A session exists for this exact directory | `codex resume <id>` |
| No session for this directory (e.g. a new instance in a shared repo) | a new conversation |
| Session database unreadable, another Codex instance shares the git repo | a new conversation, plus a notice in the instance's topic |
| Session database unreadable, no other Codex instance in the repo | `codex resume --last`, plus a notice |

AgEnD never writes Codex state and moves no session files; sessions and locks stay in the shared `~/.codex`, so `codex resume` in a terminal still lists every instance's conversations. If Codex shows "This conversation is open in another app" or its "Working directory · resume" picker, AgEnD holds delivery and tells the operator instead of pressing a key. Also detects "You've hit your usage limit" as a pause-triggering error.

**Where `~/.codex` is.** Everywhere above, the shared Codex home is `$CODEX_HOME` when that is set in the fleet's environment, and `~/.codex` otherwise. Each instance itself runs with a private `CODEX_HOME` under `~/.agend/cx/<hash>/`: its own `config.toml` (your settings without other instances' AgEnD MCP entries, plus its own), with the login, sessions and caches linked back to the shared home.

## Codex custom provider

A Codex instance can run on a model provider defined in your Codex config instead of the default:

```yaml
instances:
  glm-agent:
    backend: codex
    model: <a model the provider serves>
    backend_options:
      codex:
        provider: glm
```

The instance is launched with `-c model_provider="glm"`. The provider itself (`[model_providers.glm]`, its base URL and key variable) is defined in the shared Codex `config.toml`, which each instance's private config copies. The name may only contain letters, digits, `_` and `-`. `create_instance` takes the same `backend_options.codex.provider`, and `list_models` with `instance_name` reads the model list through that instance's own config, since a custom provider can offer a different set than the account.

## Rate limit failover cooldown

A 5-minute cooldown prevents repeated model failover triggering. After a failover occurs, subsequent rate limit errors within the cooldown window are suppressed. This prevents cascading failovers when error text persists in the terminal buffer.

## CLI UX improvements

- `agend fleet restart <name>` — restart a specific instance instead of the entire fleet
- `agend attach` — fuzzy match with interactive numbered menu when ambiguous
- `agend logs` — standalone log viewer with ANSI stripping, `-n/--lines` and `-f/--follow` options

## .env priority override

Values in `~/.agend/.env` now properly override inherited shell environment variables. This ensures token isolation — a bot token set in `.env` takes precedence over any `AGEND_BOT_TOKEN` that might exist in the shell environment.

## Backend-aware General instructions

When auto-creating the General topic instance, AgEnD writes the correct instruction file based on the configured backend:

- Claude Code → `CLAUDE.md`
- Codex, OpenCode, Grok Build, Meta Muse Code → `AGENTS.md`
- Kiro CLI → `.kiro/steering/project.md`
- Antigravity CLI → `.agents/agents.md`

An existing file is left alone.

## Builtin text standardization

All system-generated text (schedule notifications, voice message labels, general instructions, fleet notifications) is now in English. Previously some messages were in Chinese. One exception remains: the progress bubble (`處理中…`, the retired `🧾 工具歷程` history and the `tool_progress` labels) is still hard-coded in Chinese.

## AGEND_HOME — configurable data directory

Set `AGEND_HOME` environment variable to change the data directory (default: `~/.agend`). Useful for running multiple isolated AgEnD installations. Each AGEND_HOME gets its own tmux socket to prevent conflicts.

## Fleet templates

Define reusable fleet configurations in `fleet.yaml` under the `templates` section. Deploy a template to create multiple instances and a team in one operation:

- `deploy_template` — creates instances (each with its own git worktree) and optionally a team
- `teardown_deployment` — stops and deletes all instances and team from a deployment
- `list_deployments` — shows active deployments with instance status

## Unified additive system prompt

Fleet instructions are injected additively — they don't override the CLI's built-in system prompt. Each backend uses its native mechanism:

- Claude Code: `--append-system-prompt-file` (the file is `fleet-instructions.md` in the instance directory)
- Kiro CLI: the `prompt` of the instance's own agent, `.kiro/agents/agend-<instance>-<fleet>.json` (see [Kiro instances in one working directory](#kiro-instances-in-one-working-directory)). On a kiro-cli older than 2.21, and for a resumed conversation until it is switched to its agent, the steering file `.kiro/steering/agend-<instance>.md` instead.
- Codex, Grok Build, Meta Muse Code: a marked block in `AGENTS.md` in the working directory
- Antigravity CLI: a marked block in `.agents/agents.md` in the working directory
- OpenCode: `fleet-instructions.md` in the instance directory, added to the `instructions` list of `opencode.json` in the working directory

## Auto-dismiss interactive prompts

Backend-defined startup and runtime dialogs are automatically dismissed without human intervention:

- Trust folder confirmations
- Resume session pickers
- Rate limit model switch prompts (Codex)
- Permission bypass confirmations

Each backend defines its own dialog patterns and key sequences in `getStartupDialogs()` and `getRuntimeDialogs()`.

## CLI mode (agent_mode)

Alternative to MCP tools for backends that don't support MCP well. Set `agent_mode: cli` in fleet.yaml to use an HTTP-based agent CLI endpoint instead of MCP server. The agent CLI provides the same fleet tools via command-line HTTP calls.

## Error state warning

When `send_to_instance`, `delegate_task`, or `request_information` targets an instance that is rate-limited, paused, or in crash loop, the sender receives a warning in the tool response:

```json
{ "sent": true, "warning": "instance-name is currently in error state..." }
```

The message is still delivered — the warning is advisory, letting the sender decide whether to retry or escalate.

## systemPrompt file paths

The `systemPrompt` field in fleet.yaml supports a `file:` prefix to load content from a file:

```yaml
instances:
  my-project:
    systemPrompt: "file:prompts/role.md"
```

A relative path is resolved against the **instance's `working_directory`** (#1314); `~/` and absolute paths are used as given. That directory is where a relative path *starts*, not a boundary: `../` and symlinks can lead out of it, just as an absolute path can name any file the fleet's user can read. `~name/` (another user's home) is not supported; it is refused with a warning, never read as a directory called `~name`. Before 2.1.13 it was the fleet process's current directory (`~/.agend` under the installed service, the shell's directory after a manual `agend fleet start`). For one release, a relative path whose file is missing under the working directory still falls back to the old fleet-directory file: the log names both paths and the instance's topic is told once. The fallback is removed in 2.2.

Several parts can be combined with commas (`"file:a.md, file:b.md"`, inline text allowed between them); they are joined with blank lines. The value is split on commas **only when at least one part is a `file:` reference**, so an inline prompt such as `"You are Kuro, a careful reviewer"` stays one paragraph. A file that cannot be read, is larger than 256 KiB, or is not a regular file (a FIFO or a device — opened without blocking) contributes nothing; the log names its path and the error (never its contents), and config validation warns about a reference that names no file. The `workflow: "file:…"` setting reads its file the same way.

## Staggered startup

Configure parallel instance startup with concurrency limits:

```yaml
defaults:
  startup:
    concurrency: 3        # max instances starting simultaneously
    stagger_delay_ms: 2000 # delay between groups
```

Instances sharing the same working directory are serialized within a group to avoid config file races.

## Kiro instances in one working directory

Each kiro instance runs as its own kiro agent, `.kiro/agents/agend-<instance>-<fleet>.json` in its working directory, and resumes its own conversation by id. That agent holds only this instance's AgEnD MCP server and its instructions, so kiro instances that share a working directory no longer start each other's AgEnD server, read each other's instructions, or resume each other's conversation. The details are in the [design](design/kiro-per-instance-agent.md). It needs kiro-cli 2.21 or newer; an older one runs as before and says so when the instance starts.

- **Your own MCP servers stay.** The agent includes the global `~/.kiro/settings/mcp.json` and the workspace `.kiro/settings/mcp.json`. AgEnD no longer writes its own entries there.
- **The switch, once per instance.** A conversation from before this version comes back as the agent it was saved under. On its first resume, AgEnD types `/agent swap <agent>` into the pane, checks the switch on screen, and only then removes that instance's old shared entries. If it cannot confirm the switch within 15 seconds, the old setup stays, a notice says so, and the next start tries again.
- **When isolation is complete.** A removed entry is guaranteed gone from a running session only after its next start. Isolation in a directory is complete once every kiro instance there has confirmed its switch and started once more since: the switch at the first start after the upgrade, the completion at the start after that.
- **Two instances, one old conversation.** At the upgrade, two existing instances in one directory both point at the directory's newest conversation. The first to start keeps it; the other starts a new one.
- **An old instructions file.** A `.kiro/steering/agend-<instance>.md` written before this version carries no fleet tag. AgEnD cannot tell which fleet wrote it, so it keeps it and says so once. Delete it by hand once every fleet using that directory has upgraded; until then kiro still loads it for every agent there.
- **Two fleets on one directory.** Two fleets updating the shared `.kiro/settings/mcp.json` at the same moment can bring back an entry the other just removed. That instance's next start removes it again.
- **Grok** has no per-instance agent yet: Grok instances that share a working directory share its project-level MCP configuration. Run them from separate worktrees ([#1411](https://github.com/songsid/AgEnD/issues/1411)).

## Antigravity CLI backend

AgEnD supports Google's Antigravity CLI (`agy`) as a backend. Like every other backend it uses MCP by default. Set `agent_mode: cli` to use `agend-agent` commands for fleet communication instead.

```yaml
instances:
  my-agent:
    backend: antigravity
    # agent_mode defaults to "mcp"; set "cli" to use agend-agent commands
```

### Workspace handling

agy 1.1.0 and later accept working directories under hidden paths such as `~/.agend/workspaces/`, so an instance runs in its configured working directory like any other backend (the old redirect to `~/agend-workspaces/<instanceName>/` is gone). Fleet instructions are written as a marked block in `.agents/agents.md` inside that directory.

### Trust prompt

Agy's "Do you trust this folder?" prompt is automatically dismissed on startup.

## Meta Muse Code backend

Meta Muse Code (`muse`) is supported as a backend since 2.1.6.

```yaml
instances:
  my-muse:
    backend: muse
```

Install with `/login muse`, or in a shell: `mkdir -p "$HOME/.local/bin" && curl -fsSL https://api.meta.ai/muse-launcher.sh -o "$HOME/.local/bin/muse" && chmod +x "$HOME/.local/bin/muse" && MUSE_LAUNCHER_INSTALL=1 "$HOME/.local/bin/muse"`. The launcher keeps its binary next to itself, so it is saved as `~/.local/bin/muse` first; piped straight into `bash` it would download into the current directory instead and sign in with `muse login`. `/login` does not cover muse yet. Muse steers rather than queues: a message sent while a turn is running is taken into that turn, so `/steer` works (verified on muse 1.3.0). `/clear` starts a new conversation. Subscription usage is relayed from muse's response stream into `/usage`.

## Grok Build backend

AgEnD supports xAI's Grok Build CLI (`grok`) as a backend. It needs Grok CLI 1.0.13 or later: the server refuses older versions (HTTP 426), and AgEnD then tells the operator to run `grok update`.

```yaml
instances:
  my-grok:
    backend: grok
```

### Authentication

Grok uses x.ai OAuth device flow. On first launch:
1. TUI displays a device code (e.g., `5M6B-584D`)
2. User opens the URL in browser and enters the code
3. Credentials persist in `~/.grok/` across restarts

In headless environments (SSH, Docker), the URL must be opened manually on another machine.

### Known features

- **Git awareness** — displays branch + worktree on startup
- **TUI mode** — full-screen terminal UI (not bare prompt)
- **Context display** — shows `used / total` tokens (e.g. `12K / 500K`); AgEnD's `/ctx` and `agend ls` parse this to a percentage
- **Cancel key** — Ctrl+C (interrupts generation; verified against the live CLI)
- **Session resume** — `--resume <session-id>` (auto-managed: AgEnD persists the id per working directory). `--continue` is deliberately NOT used — it exits when there is no prior session
- **Tool approval** — launched with `--always-approve` unless `skipPermissions` is false; a runtime-dialog rule approves the prompt as a fallback
- **Session isolation** — grok stores sessions per working directory (`~/.grok/sessions/<encoded cwd>/`), so instances with different working directories never pick up each other's session

### Slash commands

| Command | Description |
|---------|-------------|
| `/dashboard` | Open web dashboard |
| `/home` | Go to home screen |
| `/resume` | Resume previous session |
| `/rename` | Rename current session |
| `/session-info` | Show session details |
| `/feedback` | Send feedback |

### Known limitations

- Login requires device flow — headless environments need manual browser access
- Upgrade prompts are non-blocking but occupy TUI space
- Context shows token count (e.g., "12K tokens") rather than percentage — `agend ls` parser handles this
- `ctrl+q` quits; AgEnD cancels with Ctrl+C and never sends Ctrl+Q for a cancel

## OpenCode backend

OpenCode (`backend: opencode`) is configured like any other backend.

```yaml
instances:
  my-opencode:
    backend: opencode
    model: provider/model   # as `opencode models` lists them
```

- **Config and instructions.** OpenCode reads `opencode.json` from the working directory. AgEnD merges into that file rather than replacing it: it adds this instance's MCP server under its own key (`<server>-<instance>`, so several instances can share a directory) and appends `fleet-instructions.md` from the instance directory to the `instructions` list. Your own entries stay.
- **Permissions.** With `skipPermissions` (the default), OpenCode is launched with `--auto` when its `--help` lists the flag; explicit `deny` rules in your config still apply. An older OpenCode gets no launch switch, and its "Permission required" prompts are answered "Allow once" at runtime.
- **Session resume.** Only the session AgEnD recorded for this instance is resumed (`--session <id>`). OpenCode's `--continue` is never used: it is global and could pick up another directory's session.
- **Controls.** Cancel is Escape (Ctrl+C would exit OpenCode); `/compact` and `/clear` are passed through. Reasoning effort is not supported. `list_models` reads `opencode models`.
- **Sign-in.** `/login opencode` installs the CLI if it is missing but has no sign-in flow: sign in on the host with OpenCode itself (AgEnD checks the result with `opencode auth list`).

## Auto-Pause & Wake

Idle instances can be automatically paused to save resources, and automatically woken when a message arrives.

### How it works

- **Auto-pause**: when an instance has no activity for `auto_pause_after` minutes, it's paused (tmux window kept, CLI suspended)
- **Auto-wake**: when a user sends a message to a paused instance, it wakes automatically (~30 seconds to resume)
- **Working protection**: instances actively generating responses are never paused

### Configuration

```yaml
defaults:
  auto_pause_after: 0    # 0 = disabled (default). Set minutes > 0 to enable.

instances:
  my-agent:
    auto_pause_after: 30  # per-instance override: pause after 30 min idle
```

Also configurable via the Settings web page: **Runtime & Resources → auto_pause_after**.

### Manual control

| Command | Platform | Description |
|---------|----------|-------------|
| `/pause` | DC slash / TG command | Manually pause an instance (admin only) |
| `/wake` | DC slash / TG command | Manually wake a paused instance (admin only) |

### Status visibility

- `agend ls` → Status column shows "Paused" with a dim yellow ○
- `/status` → ⏸ icon next to paused instances
- Settings page → "Wake" button (instead of "Start") for paused instances
- MCP `list_instances` → `status: "paused"`

### Behavior notes

- Paused instances do not consume CPU or RAM (CLI is suspended)
- Messages to paused instances trigger auto-wake — users don't need to manually wake
- Cross-instance messages (`send_to_instance`) also trigger auto-wake
- Schedule triggers wake the instance before delivery
- Wake takes ~30 seconds (CLI resumes session context)

### Recommended values

| Scenario | Suggested value |
|----------|----------------|
| Solo developer (few instances) | `0` (disabled) — keep always-on |
| Team fleet (10+ instances) | `30` (30 min) — saves resources |
| Large fleet (cost-sensitive) | `10` — aggressive pause |
| Always-on requirement | `0` or omit |

## Warm Cap (LRU Evict)

Fleet-wide cap on how many instances may be simultaneously **warm** (resident — tmux window + CLI process running), independent of `auto_pause_after`'s per-instance idle timer.

- Configure with `defaults.warm_cap` (number, default `0` = unlimited).
- When the count of running instances exceeds the cap, the **least-recently-active idle instance** is auto-paused (LRU eviction) to make room.
- `general` instances (and anything running) are never evicted — only idle, non-general instances are candidates.
- Complements `auto_pause_after`: that pauses an instance after *it* has been idle long enough; `warm_cap` pauses the *oldest idle* instance the moment the fleet-wide resident count goes over budget, even if no single instance has hit its own idle threshold yet.
- Paused-by-eviction instances wake the same way as any other paused instance — see [Auto-Pause & Wake](#auto-pause--wake).

```yaml
defaults:
  warm_cap: 15   # at most 15 instances resident at once; excess idle instances get evicted
```

## Waking paused instances for queued work (`delivery_worker`)

Since 2.1.9, restarting a paused instance wakes it, and a woken instance stays awake until its queued work is done: work from other instances counts as activity. Start, stop, wake and restart of one instance run one at a time.

A cross-instance message (`send_to_instance`, `delegate_task`, …) to a paused instance wakes it, including an instance that has stayed paused across a fleet restart. That is the default (`wake_only`, since #1129). Under `off`, a message to an instance paused across a fleet restart stays queued until someone wakes it by hand (one paused since the fleet started is still woken when its message is delivered).

| Value | What it does |
|-------|--------------|
| `wake_only` (default) | A wake coordinator wakes a paused target when queued work is waiting, through the same single wake `/wake` uses. It retries with backoff, tells both topics after three failures in a row, and never wakes an instance paused for a login failure. |
| `on` (canary) | As `wake_only`, and one worker owns the target's delivery lane: it waits until the CLI accepts input, then hands over one message at a time. |
| `off` | No wake for queued work: an instance paused across a fleet restart keeps its messages queued until a manual `/wake` (the behaviour before #1129). |

With `wake_only` or `on`, `defaults.warm_overflow` (default 2) is how far `warm_cap` may be exceeded to wake a target for queued work. When `warm_cap` plus overflow is full and no idle instance can be paused, a `/wake` or a message to a paused instance is refused instead of exceeding the cap.

```yaml
defaults:
  delivery_worker: off   # opt out of waking for queued work
instances:
  my-agent:
    delivery_worker: on   # per-instance override
```

## IPC + adapter auto-reconnect

When network interruptions cause IPC connections or Telegram/Discord adapters to drop, AgEnD automatically recovers:

- **IPC disconnect**: retries with exponential backoff (3s, 6s, 12s) then every 60 seconds indefinitely. Each cycle checks if the tmux pane is still alive — if dead, respawns the instance.
- **Adapter fatal error**: retries with backoff (5s, 10s, 20s) then every 60 seconds indefinitely. Covers Telegram polling init failures and Discord gateway disconnects.

Both mechanisms are suppressed during intentional shutdown (`agend stop` / fleet restart). Log spam is limited to one WARN every 10 retry attempts.

## Parallel instance stop

Fleet shutdown (`agend fleet stop`, `agend stop`) stops instances in parallel batches whose size scales with the fleet: 5 at a time for fewer than 10 instances, 10 for 10–30, and 15 for more than 30. The systemd unit bounds the whole stop with `TimeoutStopSec=60`.

Since 2.1.9 the systemd unit uses `KillMode=mixed`: systemd signals only the fleet, which then quits each CLI in turn. Before this, every CLI got SIGTERM at the same moment, and on WSL kiro-cli aborted into a core dump of about 1 GB each time (#908). `agend restart` adds the line to an older unit; see [CLI reference](cli.md#setup--installation).

## Beta and alpha update channels

Three npm dist-tags, one per line: `@latest` (stable), `@beta` (the next patch) and `@alpha` (previews of the
next minor, e.g. 2.2.0-alpha.N while 2.1.x is current). Install pre-release versions with:

```bash
agend update            # Stay on the installed channel: an alpha from @alpha, a beta from @beta, a stable from @latest
agend update --alpha    # Install from the @alpha npm dist-tag
agend update --beta     # Install from the @beta npm dist-tag
agend update --stable   # Install from @latest, even from a beta or alpha install
```

`/update` in chat does the same as `agend update`: an install stays on its channel. An update that would go
back to an older version (say an alpha asking for @beta) is refused; `--stable`, `--version` or `--force` say
that is what you want. The "update available" notice follows the same channel. An alpha install is told about
a newer alpha or a newer stable, never about a beta.

A release is a pushed `v*` tag. The publish workflow maps it strictly: `vX.Y.Z` → `@latest`, `vX.Y.Z-beta.N`
→ `@beta`, `vX.Y.Z-alpha.N` → `@alpha`. Any other tag (an `-rc.N`, a typo) fails the job before anything is
built, and a stable older than the current `@latest` is refused. When a minor goes stable (2.2.0), point
`@alpha` at it too (`npm dist-tag add @songsid/agend@2.2.0 alpha`): alpha installs are not told about a stable
of their own version.

## PSS memory reporting

`agend ls` reports memory using PSS (Proportional Set Size) from `/proc/<pid>/smaps_rollup` instead of RSS. This avoids double-counting shared library pages across the process tree, giving a more accurate picture of actual memory consumption. Falls back to RSS on non-Linux systems.

## Host memory pressure

One fleet-wide sampler reads host memory every 30 seconds and before every spawn admission (startup, wake, restart and recovery). On **Linux** it throttles new CLIs, and never touches running ones:

- available RAM below `max(300 MiB, 2% of RAM)`, or below `max(2 × that, 5% of RAM)` with swap at most 5% free → **critical**: no new CLI starts; the request waits and is retried after 5, 10, 20, 40 and then every 60 seconds;
- RAM below that second threshold, or swap at most 5% free → **elevated**: one start at a time, at least 5 seconds apart (an unreadable sample is treated the same way, never as zero RAM);
- after a critical hold clears, starts ramp back up slowly for 30 seconds.

`/health` always carries a `hostMemory` block (level, RAM and swap, trend); on Linux, pressure also marks it degraded, and a fleet notice is sent with a 10-minute cooldown (an escalation to critical is sent at once). On **macOS** the sample is written to the log only since #1257: nothing is slowed or held, no notice is sent, and `/health` does not report pressure, because macOS's free-memory and swap numbers alerted on machines with plenty of memory. Details: [memory-pressure.md](memory-pressure.md).

## "Needs you" inbox (#1386 / #1398)

A single live **Needs you** message in each world's General topic surfaces everything currently waiting on the operator — delivery acknowledgements, hang alerts, permission prompts — across all instances. Every item in the message is one tap from where it is acted on: the instance's own thread or the message's existing buttons. The only new interaction is **Acknowledge** for delivery items that have no button today. The same list appears in the `/ui` web dashboard with a sidebar badge. Items resolved on any surface disappear everywhere. Design: [docs/design/1386-needs-you-inbox.md](design/1386-needs-you-inbox.md).

## Web app shell (#1408)

`/ui` is rebuilt as a single unified Preact + htm app (vendored, no build step) that replaces the old `/view` and `/settings` pages with one coherent shell. Typography and layout are modelled on ChatGPT's web UI (design language only — no OpenAI code or assets). The chat thread stays a keyed DOM renderer mounted by a Preact component. The shell hosts the session list, instance chat, settings panel and the Needs you view under one URL. Design: [docs/design/1408-app-shell.md](design/1408-app-shell.md).
