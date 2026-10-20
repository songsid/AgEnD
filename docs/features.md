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

A missed run is run once, never twice (#1995):
- **After a restart.** A run that came due while the fleet was down, within the last 24 hours, runs once at startup.
- **While the fleet runs.** A run that came due and did not start within 3 minutes gets the same single catch-up, with the same run id, so a late but real trigger does not run it again. A run skipped because the previous run of the same schedule was still going stays skipped. The fleet log says `Missed cron tick — catching up`.
- **In the fleet log.** Each registration logs `Cron schedule registered` with the schedule id, where it came from (`init`, `reload`, `create`, `update`, `repair`) and its next run. A schedule that is enabled but has no job (for example one added by `agend schedule add` whose reload was lost) is noticed within a minute, logged as `Cron schedule was not registered — registering`, and its missed run is caught up as above. Each trigger logs a `Cron tick` line with the schedule id and run id. A trigger that does not start logs `Cron tick not run` with the reason (`disabled`, `still_running`, `already_ran`, …), and a run that fails logs `Schedule run failed`.

**Fleet → Schedules** in the web dashboard shows all schedules and lets you manage them (#1724):
- Each row shows the schedule in words ("Weekdays 18:00", "Every 15 minutes", "Once · 2026-10-13 14:00 (UTC+8)") and the next run in the fleet's timezone. The raw cron expression moves to the tooltip. Disabled schedules are visually marked.
- **Edit** opens the schedule form filled in, with a **Repeat / Once** toggle. Saving goes through the same validation as the `update_schedule` tool.
- **New schedule** can create one-time schedules as well as recurring ones.
- A temporary public link can view schedules but cannot create, edit, or delete them.

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
- Every other backend gets a one-line notice to reload its own instruction file (`AGENTS.md`, kiro's agent file or steering file, `.agents/AGENTS.md`, …). If no message is waiting, the notice is deferred to the next real message rather than provoking an unsolicited reply; if a delivery is already queued, the daemon waits for idle and pastes the notice first.

No configuration is needed.

## Per-version what's-new notice (#1633)

After an upgrade, each existing instance gets one short notice delivered just before the next message it receives — never in the middle of a turn, never to an instance nobody writes to. The notice lists agent-facing changes with their exact parameter names and tells the agent to reload any tool description that looks older than the current version. Each item is sent at most once per instance; the record survives daemon restarts. New instances start with the current tools and receive nothing. A version with no agent-facing changes sends nothing.

**Who is told what, and the skills it names (2.2.5, #2163).** An item meant for General or for coordinators (the web-settings tools, for example) reaches only General and instances with the coordinator or full tool set; the others record it as known without being told. A notice that names a skill also says how to read it anywhere: `agend-agent skill <name>` prints a skill AgEnD ships, and `agend-agent skill` lists them. The skills are published as files by role: General gets them all, fleet workers the ones marked for workers, and a ClassicBot room's agent only `web-appearance`, `persona-emoji` and `web-dashboard`, and only into its own AgEnD-managed folder under `<AGEND_HOME>/workspaces/`. A Classic folder elsewhere gets nothing written, nor does a link inside that folder to one elsewhere.

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

### Reply buttons

An agent can offer choices people click instead of typing (2.2). The same buttons appear in the web chat, on Telegram (an inline keyboard) and on Discord (message components).

- **Sending:** `reply` takes `buttons`: 1–10 items, each `{ label, value? }`.
  - A label is one line of plain text, at most 80 characters (Discord's limit, the strictest).
  - `value` (at most 200 characters) is what the agent receives when it differs from the label. It stays in AgEnD and is never sent to a platform.
  - Buttons need `text` and go on its last message. They cannot be combined with `stickers`; `files` are sent after the text as usual.
  - An invalid `buttons` is the reply's error, and nothing is sent.
- **A click** reaches the agent as an ordinary message from the person who clicked: `[button] Deploy`, or `[button] Deploy (value: deploy-prod)` when the value differs. It also shows in the web chat.
  - Discord and Telegram clicks use the same working/cancel bubble as typed messages, including its progress and idle/reply cleanup. Received and processing status reactions appear on the reply carrying the buttons, since a click creates no new platform message. Web choices use the same daemon-driven working/Stop state; their synthetic message ids are never sent to a platform reaction API.
  - If delivery fails, the platform status changes to failed and the choice reopens for retry. A successful retry replaces the failed status through the same delivery reconciler.
- **One choice per reply.** The first permitted click answers for everyone. The buttons then show the choice and who made it on every surface: on Discord they are disabled with the choice marked, Telegram shows a single "✓ Deploy — alice" button, and the web chat disables them. A later click is told "Already answered."
- **Who may click:** whoever may message that instance there.
  - In a fleet topic, the connection's allowed users.
  - In a ClassicBot room, anyone there.
  - In the web chat, the signed-in user, or a visitor using the public link (who may send messages too).
  - A bot's click never counts.
- **Lifetime:** buttons expire after 24 hours and then say so. They survive an AgEnD restart: each set is a row in `reply-buttons.db`, matched to the exact message it was posted on and answered once, so a click cannot be replayed.
- **Where buttons cannot be shown,** for example through `agend-agent reply`, the choices are added to the text as a numbered list for people to answer by writing back.
- **Security:** a platform carries only an unguessable id and the button's index, never a label or value. Labels are always shown as plain text.

#### Polls

`reply` with `buttons` and `poll` makes the buttons a timed, Kahoot-style vote (#1823) on Discord and Telegram (fleet topics and ClassicBot rooms) and in the web chat. AgEnD only counts votes; the right answer, scores and any leaderboard are up to the agent, from the results. A quiz is one poll per question.

- **Sending:** `poll: { seconds, multi?, reveal?, show_voters? }` with 2–10 `buttons` as its options.
  - `seconds`: 10 s to 24 h. The poll opens as it is posted (its clock starts just before the message is sent, so the deadline is known when it goes out) and closes that long after.
  - `multi` (default off): each voter may pick several options; a click toggles one.
  - `reveal`: `"close"` (default) shows only "N answered" and the time left while the poll is open, and the counts at close. `"live"` also shows the counts as votes come.
  - `show_voters` (default off): at close, one follow-up message under the poll names who picked what.
  - The reply's result has `poll_id`. Where a poll cannot be shown (`agend-agent reply`, an instance without the fleet), the reply is refused rather than sent as text.
- **Voting:** whoever may click reply buttons there may vote, once each, and may change their vote. A voter's own choice is confirmed to them alone: an ephemeral reply on Discord, a toast on Telegram, and in the web chat the page marks it (this device remembers it). Clicking the option already chosen changes nothing.
  - **In the web chat** each signed-in device (its session) is one voter, named `web · <device> (<4 characters of its id>)`, and a public-link visitor may vote too, as for reply buttons. The same person on two devices votes twice. A poll posted on Discord or Telegram can also be voted on from the web chat.
- **While open:** Discord counts the deadline down itself (`⏳ Closes in …`); Telegram redraws a status button (`🗳 3 answered · ⏳ 1:35`) every 5 s in the last two minutes, then less often; the web chat counts down every second. Redraws are coalesced, at most one every 2 s per channel (Discord) or 3 s per group (Telegram, whose edit limit its topics share); web pages are told new votes at most once a second.
- **At close:** the buttons are retired and show each option's count and share; a late click is told the poll is closed. The agent receives one message from AgEnD in the poll's chat, `[poll results]`, and is expected to answer it there: per option its count and voters, each with a stable id (`<connection>:<user id>`) and the ms from the poll opening to that voter's last change. A changed vote counts from its last change. AgEnD only counts votes.
- **Early close:** `close_poll({ poll_id })` closes one of the instance's own open polls now (for example when everyone has answered). It is the same close as at the deadline; the results say `closed early by close_poll after N s`.
- **Exactly once, across restarts:** the deadline is stored with the poll in `reply-buttons.db`. A poll whose deadline passed while AgEnD was down closes at the next start, and its results say how late. The results go through the delivery outbox under the poll's id, so they reach the agent once even if AgEnD stops while handing them over.

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

It is on by default (`reply_completion_guard: true`); set `false` per instance, in `defaults`, or per ClassicBot channel to turn it off.

Which backends have it:
- **Claude Code** and successful **Kiro** legacy/TUI launches.
- **Codex** and **Muse**, which additionally need the CLI's own session log to show that the turn holding your message ended and that nothing started after it. On Muse, a message typed mid-run starts a second run; that one must end too. An interrupted turn (Esc) or one that ended on a provider error is left alone. A turn that cannot be found in the log is left alone too, as before.

Other backends do not have it.

## Peer-to-peer agent collaboration

Instances collaborate through the tools their profiles allow. Ordinary workers can discover and message peers; creating, starting or waking instances requires the appropriate orchestration permission. See [tool profiles](features.md#tool-profiles).

**Core MCP tools:**

- `list_instances` — discover all configured instances (running or stopped) with status, working directory, and last activity
- `send_to_instance` — send a message to another fleet instance; supports structured metadata (`request_kind`, `requires_reply`, `correlation_id`, `task_summary`)
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
- `waiting_reason` (#1641): on a `queued` or `retry_wait` row, why the target is not taking it, in words ("The CLI appears stuck.", paused, a dialog, a login failure), or null when it is simply next in line. If an always-on target's queued work has waited 30 minutes for such a reason, its topic is told once.

An instance sees rows it sent, received, or was explicitly granted through `forwards` (its identity comes from its own socket or token, never from an argument). Looking up an inbound message's `message_id` helps verify retained delivery evidence. "Delivery not found" can mean ACL-hidden, expired retention, or no delivery; it is not proof of non-delivery. Do not act on an unverifiable reference: ask the sender to explicitly forward one you can verify. Every tool profile has `delivery_status`, `minimal` included.

`send_to_instance` and `delegate_task` accept an optional `forwards` list of up to 16 delivered message IDs the sender can already read. The receiver may then call `delivery_status` on those IDs — including a human consent receipt (`verification_id` / `agend-human-id`). Every hop in a relay chain must include `forwards` explicitly; writing an ID in the message text grants nothing. Human receipts preserve the original actor, adapter, platform and content separately from the formatted wire payload, and remain uncertain without owned submission evidence. See [cross-instance-messaging.md](cross-instance-messaging.md) and [delivery-verification.md](delivery-verification.md) for the full guidance.

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

Decisions are rules and conventions that outlive a conversation. `post_decision` records one with a `title` and `content`, optional `tags`, a `ttl_days` after which it is archived (default: permanent), and `supersedes` to replace an older one. `scope: "project"` (the default) makes it visible to instances working in the same directory; `scope: "fleet"` to every instance. `list_decisions` lists the active ones by title (id, title, scope, date, tags; `include_archived` and `tags` filter): pass `id` for one decision's full text or `full: true` for all of it (2.2.5, #2152 — the full list had grown to over 100 KB), and `update_decision` changes or archives one — a coordinator verb, since it edits what somebody else recorded.

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

External sessions can register an identity, appear in `list_instances`, and call permitted fleet tools. Registration does not establish a proven inbound channel into the external CLI’s own conversation; do not rely on `send_to_instance` to submit a turn there.

## Tool profiles

What an agent may do is decided per instance by `tool_set`, and enforced by the
fleet rather than by what the model was shown. Three profiles matter:

| profile | how you get it | what it is |
|---|---|---|
| `worker` | **the default** | Talk to people and to peers, read the fleet, do the work. `reply`, `send_to_instance`, `broadcast`, `report_result`, `request_information`, `delegate_task`, `delivery_status`, `task`, `post_decision`, `checkout_repo` / `release_repo`, and every read-only query — including `list_schedules` and `list_deployments`, so it can see what exists without being able to change it. Since 2.1.6 it may also create and change schedules that target itself (#896), and it can list, preview and set its own persona emoji and list and preview stickers. 39 tools. |
| `coordinator` | `tool_set: coordinator` | Everything a worker has, plus the verbs that run the fleet: create/delete/replace/start/stop/restart/wake instances, deploy and tear down templates, team CRUD, creating and changing schedules, `update_instance_config`, `update_fleet_defaults`, `update_decision`. |
| `full` | `tool_set: full` | Every tool AgEnD has. |

**`coordinator` and `full` are the same 55 tools today** — the difference is what
they mean, not what they contain. `coordinator` says "this agent runs the fleet",
and will be narrowed if a verb turns out not to belong there; `full` says "give
this one everything regardless", and is the name the old default had. If you want
an agent to coordinate, write `coordinator` — reaching for `full` to get *more*
gets you nothing extra and opts you out of every future refinement.

`standard` (30 tools) and `minimal` (9) still exist. `minimal` gained `list_emojis` and `preview_emojis` in 2.1.9, and `list_stickers` and `preview_stickers` in 2.1.12.
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

**`tool_set` and `skipPermissions` can only be set through Settings or by editing `fleet.yaml`.** Sending `tool_set` through `update_instance_config` is refused with a privilege-boundary error (#804/#814). `create_instance` refuses both fields explicitly. (`skipPermissions` is not an accepted field for `update_instance_config`; Zod strips it silently.)

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

When an instance approaches the limit, a warning is posted to its Telegram topic. When the limit is reached, the instance is stopped and a notification is sent. It does not resume by itself; start it again to continue.

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
- **`/model`** (channel admin) — switch the instance's model from a menu (on Telegram also `/model <name>`). From 2.2.5 the menu is the catalog of the account the instance runs on (a Claude Code [credential profile](#credential-profiles-and-a-second-subscription) has its own), and the model it runs is always a choice: one its CLI does not list comes first, marked "current — not in this CLI's list". See [Backend availability and model lists](#backend-availability-and-model-lists-225).
- **`/backend`** (channel admin, as `/model`) — move the instance to another CLI backend: pick the backend, then its model (`/model`'s list, or the default), then its effort (`/effort`'s levels, skipped for a backend without one), then confirm. The instance restarts **once**, at the end, in a **fresh session**: a conversation does not carry across backends. `/backend <backend> [model] [effort]` goes straight to the confirmation. From 2.2.5 every backend is listed with what this host says about it ([backend availability](#backend-availability-and-model-lists-225)): one that is not installed, not signed in or too old is shown disabled with the reason, and is refused with it when typed; one not checked yet stays selectable; the current backend is never disabled. A Discord select menu cannot disable an option, so there the reason is in the label and choosing it says why. Fleet instances only; a ClassicBot agent's backend is set in `classicBot.yaml` or Settings.
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

If an instance is working but its screen has not changed for 10 minutes (`hang_detector.timeout_minutes`), the daemon posts a notification with inline buttons:

- **Force restart** — stops and restarts the instance
- **Keep waiting** — dismisses the alert

Detection follows the pane's state: a turn whose screen output has stopped for the whole timeout counts as stuck; any new output restarts the clock.

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
- **Slash commands**: 28, including `/chat`, `/steer`, `/btw`, `/cancel`, `/ctx`, `/compact`, `/model`, `/backend`, `/effort`, `/web`, `/usage`, `/login`; the ones that need an admin are marked 🔒 (the mark is generated from the same table that enforces it).
- **Buttons and menus**: permission approval (Allow / Always / Deny), backend picker, cancel, and hang / model / backend / effort pickers.
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

The recommended setup wizard detects installed backends and generates a minimal `fleet.yaml`. Telegram discovers the group and user from a `/start` message. Discord detects the account from a guild message or DM, asks for explicit confirmation, and falls back to required snowflake-validated manual entry. The web wizard also requires a valid admin ID.

## Web Dashboard

The fleet serves a web dashboard on `127.0.0.1` (`health_port`, default 19280). Its `/ui` is **web chat**: pick an instance and talk to it from the browser. It is the same conversation as that instance's Telegram or Discord chat: what you send from the web is echoed into the topic as `🌐 web · <your name>: …`, and the agent's replies show in both. Signed in with a `/web` code, you are your Discord or Telegram account to the agent (its user id, `via web`: the agent does your ordinary requests as you; a release, anything destructive, spending or secrets need your account's go-ahead, which authorizing that browser gives — then `via web (verified)` — see [web-dashboard.md](web-dashboard.md#who-the-agent-sees-1827)). Files and images (📎, paste or drop), Stop, and ticks showing how far each message got all work there, and a fleet with no chat platform can be run from the dashboard alone. `/view` is the read-mostly overview and `/settings` the fleet settings.

Sign in with a one-time code: send `/web` (fleet admin) or run `agend web` on the host. With [guest sign-in](#guest-web-sign-in-225) on (2.2.5, off by default), anyone else's `/web` signs them in as a guest who sees only the agents they already use in chat. To use it from a phone or another computer, see [Reaching it from elsewhere](web-dashboard.md#reaching-it-from-elsewhere). The full guide is [web-dashboard.md](web-dashboard.md).

**ClassicBot rooms echo the web chat too (2.2.5, #2054).** What you send to a ClassicBot agent from the web is posted in its room (`🌐 web · <name>: …`), group channels included, following `web.echo_to_channel` unless the room sets `web_echo` in `classicBot.yaml` (or **Web echo** in the room's Settings). After upgrading, a room that never set it starts echoing while the fleet's `web.echo_to_channel` is not off; set `web_echo: false` to keep that room quiet.

## Remote CLI sign-in (`/login`)

`/login [backend]` (fleet admin; Telegram General topic, or Discord) signs a backend CLI in — and installs it first when it is missing — without SSH. With no argument it shows a picker of every installed or installable backend. Each login runs in a temporary tmux window of its own (instance panes are untouched), times out after 10 minutes, and can be stopped with `/login cancel`.

- **Device code** — `codex` and `grok`: the URL and code are posted in the chat.
- **Browser terminal** — `claude-code` and `kiro-cli`: AgEnD opens a one-time web terminal on the login command where you finish the sign-in (and paste a code back). The link works on this machine by default (SSH forwarding, tailscale, your own proxy).
- **Install only** — `opencode` and `muse` have no sign-in flow here. Remote sign-in for `antigravity` is declined, because `agy` has no separate login command.

**Public link.** For a phone that cannot reach the machine, a `claude-code` or `kiro-cli` login offers a temporary public https link through a Cloudflare Quick Tunnel: the confirmation has **I understand (temporary public link)**, **I understand (local network)** and **Cancel**, and the first button is the consent, once per login. A `cloudflared` on `PATH` is used if there is one; otherwise AgEnD downloads Cloudflare's build into `~/.agend/bin/` once, pinned and checked against a SHA256 it ships with. The link and the access token are sent to you as two private messages, never in the channel, and the tunnel is stopped when the login ends in any way. Cloudflare terminates TLS, so it can see that terminal. `web_terminal.tunnel.allow_public: false` turns the option off for the host. Details: [configuration](configuration.md#finishing-a-login-away-from-the-machine-public-link).

**From the web dashboard (2.3, #2233).** A fleet admin signed in to the dashboard on this machine or its network (not over the public link, and never as a guest) can do the same without any chat connection: **Settings → Agents → Sign-ins** lists each backend's login and each credential profile an agent uses, with **Sign in**; the web `/backend` picker offers **Sign in to <backend>** for one that is not signed in; and **Needs you** offers **Sign in** on an agent paused for sign-in. The dialog runs the same flow: a device code is shown in the dialog; a browser-terminal login shows **Open the sign-in terminal** and its one-time access code, to that browser session only (no DM is involved, so a web-only fleet needs no bot). The same checks, limits and 10-minute window apply, a public link is still opt-in per sign-in, and while it runs every admin page says so, with **Open** (the browser that started it sees the link and code, the others only who and where, and may cancel it). A sign-in whose browser session ends is cancelled. A CLI that is not installed is not installed from here: the dialog gives its install command.

After a successful login, the backend's running instances are restarted to pick up the new credential. `/install-cli` is a leftover typed alias: it still works, says it moved, and runs `/login` with the same argument; it is in no command menu.

## Credential profiles and a second subscription

A CLI keeps its login in one place, so by default every instance of a backend shares one account. `credential_profile` gives an instance a named, separate login for **`kiro-cli`**, **`codex`** and **`claude-code`**:

```yaml
instances:
  work-agent:
    backend: kiro-cli
    backend_options:
      kiro-cli:
        credential_profile: work
```

Profiles live in `~/.agend/credential-profiles/<backend>/<profile>`, under the fleet, so several agents can point at one subscription. An instance without a profile is unaffected. Only the login is separated: kiro's large runtime caches are linked back to the shared copy, and for Codex only `auth.json` differs. Switching profiles is a config change plus a restart (`update_instance_config` does both); switching to a profile that was never logged in is refused with the command to log it in. On kiro a switch starts a new conversation, because kiro keeps conversations in the same store as its login (AgEnD hands the recent context over). On Codex the conversation stays. On Claude Code AgEnD copies the conversation into the new profile and resumes it there (#1753); the old profile keeps its own copy.

**ClassicBot channels (#1220).** A channel in `classicBot.yaml` takes the same `backend_options.<backend>.credential_profile`, over any profile inherited from the fleet defaults (an empty or `null` value means the shared login). Its agent launches on that profile, `/usage` counts it under that subscription's row (for example `Codex (personal)`), and `kiro_engine_status` reports it. An unusable profile name stops that channel's agent from starting rather than running it on another login. Changing the profile restarts the channel's agent.

`/usage`, `get_usage` and the dashboard show one row per subscription, never added together. Full reference: [configuration](configuration.md#credential-profiles-multiple-subscriptions-of-one-backend).

## Backend availability and model lists (2.2.5)

AgEnD keeps a snapshot of what this host can run (#2072). Each backend is **usable**, **not installed**, **not signed in**, **too old** (only kiro-cli has a minimum, 2.21.0) or **unknown** (not checked yet, or it cannot tell).

- **Read without starting a CLI that could update itself or reach the network.** The version comes from disk: muse's `.muse-version`, an npm install's own `package.json`, claude's `…/versions/<v>`, codex's `…/releases/<v>-<target>/`. Failing that, on Linux only, `<cli> --version` runs with no network (`unshare -rn`) and a 5 s deadline. A version it cannot read is unknown, never "too old".
- **Sign-in** is read from credential files and API-key variables, never by asking the account. Claude on macOS keeps its login in the Keychain, so it reads as unknown there. An instance with a credential profile is judged by that profile's login.
- **When:** at start, every 10 minutes and after a `/login`; requests only read the snapshot. A probe that fails keeps the last definite answer, and only a definite answer disables anything: unknown stays selectable and is checked again when applied.

Where it shows:

- **`/backend`** in chat (see [above](#diagnostics-and-per-agent-chat-commands)): an unusable backend is disabled with the reason and refused when typed.
- **The web Create agent dialog and every Settings backend field** (an agent, the fleet default, the ClassicBot default and a room, Fleet → Config): "not installed", "not signed in (use /login)" and "needs X or newer" are disabled with that reason; "not checked yet" stays selectable; the current value is always selectable, and a backend AgEnD no longer has shows first, marked removed.
- **ClassicBot's `/start`** backend list and the setup wizard read the same snapshot. The `create_instance` tool does not check it.

Model lists:

- **`/model`** and the web chat's model choices list what the instance's account can run. On Claude Code a credential profile has its own catalog, read with that profile's login; Codex and Kiro profiles share one catalog per backend. The model the instance runs is always a choice; one its CLI does not list comes first, marked "current — not in this CLI's list".
- **Every Settings model field** (an agent's model and failover, the fleet default, a ClassicBot room, the Create agent dialog) is a list of that backend's cached catalog for that account; opening it never probes. The current model is always listed. **Other…** opens a text box holding the current name: type another name the CLI accepts, or empty it to inherit. In the Create agent dialog, **Fleet default** lists the fleet default backend's models.

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

When a user replies to a previous message in Telegram, Discord or the web chat (#2272), the quoted text is included in the formatted message delivered to the agent as `(reply_to: "…")`. This gives agents context about what the user is referring to.

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

The same lines appear in each instance's web chat (#1672), by the same rules and the same mode, even on a fleet with no chat platform or for an instance with no topic. They are drawn as muted, read-only status lines: plain text, never an agent's reply (no preview cards), and a long one is folded until opened. They count toward the chat history's limits and are there again after a restart.

Only these posts change. Messages are delivered exactly as before, the [Mirror Topic](#mirror-topic) still receives every message, and General topics never show these posts in any mode.

## Mirror Topic

Configure `mirror_topic_id` in `fleet.yaml` to designate a Telegram topic for observing cross-instance communication. All `send_to_instance` messages are mirrored to this topic in real time. This is a daemon-level hook with zero changes to agent behavior — agents don't know they're being observed.

## Codex session resume

Each Codex instance resumes **its own** conversation. At launch AgEnD reads Codex's shared session database (`$CODEX_HOME/state_5.sqlite`, default: `~/.codex`) read-only and picks the newest interactive session whose recorded working directory is exactly the instance's, then runs `codex resume <id>`. It does not use `codex resume --last`: since Codex 0.157 that picks the newest session of the whole git repository, so instances on worktrees of one repo would take each other's sessions (#984).

| Situation | Launch |
|---|---|
| A session exists for this exact directory | `codex resume <id>` |
| No session for this directory (e.g. a new instance in a shared repo) | a new conversation |
| Session database unreadable, another Codex instance shares the git repo | a new conversation, plus a notice in the instance's topic |
| Session database unreadable, no other Codex instance in the repo | `codex resume --last`, plus a notice |

AgEnD never writes Codex state and moves no session files; sessions and locks stay in the shared Codex home (`$CODEX_HOME`, default: `~/.codex`), so `codex resume` in a terminal still lists every instance's conversations. If Codex shows "This conversation is open in another app" or its "Working directory · resume" picker, AgEnD holds delivery and tells the operator instead of pressing a key. Also detects "You've hit your usage limit" as a pause-triggering error.

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
- Antigravity CLI → `.agents/AGENTS.md`

An existing file is left alone.

## Builtin text standardization

All system-generated text (schedule notifications, voice message labels, general instructions, fleet notifications) is now in English. Previously some messages were in Chinese. One exception remains: the progress bubble (`處理中…`, the retired `🧾 工具歷程` history and the `tool_progress` labels) is still hard-coded in Chinese.

## AGEND_HOME — configurable data directory

Set `AGEND_HOME` environment variable to change the data directory (default: `~/.agend`). Useful for running multiple isolated AgEnD installations. Each AGEND_HOME gets its own tmux socket to prevent conflicts.

## Fleet templates

Define reusable fleet configurations in `fleet.yaml` under the `templates` section. Deploy a template to create multiple instances and a team in one operation:

- `deploy_template` — creates instances and optionally a team; with `branch`, each instance gets its own git worktree. Without it, a second role in the same directory is refused as a duplicate and the deployment is rolled back, so several roles need `branch`
- `teardown_deployment` — stops and deletes all instances and team from a deployment
- `list_deployments` — shows active deployments with instance status

## Unified additive system prompt

Fleet instructions are injected additively — they don't override the CLI's built-in system prompt. Each backend uses its native mechanism:

- Claude Code: `--append-system-prompt-file` (the file is `fleet-instructions.md` in the instance directory)
- Kiro CLI: the `prompt` of the instance's own agent, `.kiro/agents/agend-<instance>-<fleet>.json` (see [Kiro instances in one working directory](#kiro-instances-in-one-working-directory)). On a kiro-cli older than 2.21, and for a resumed conversation (its switch to the instance's agent is suspended, #1800), the steering file `.kiro/steering/agend-<instance>.md` instead. On a resume AgEnD writes both files. A resumed conversation that was already saved as the instance's own agent reads the agent's `prompt`.
- Codex, Grok Build, Meta Muse Code: a marked block in `AGENTS.md` in the working directory
- Antigravity CLI: a marked block in `.agents/AGENTS.md` in the working directory
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

A relative path is resolved against the **instance's `working_directory`** (#1314); `~/` and absolute paths are used as given. That directory is where a relative path *starts*, not a boundary: `../` and symlinks can lead out of it, just as an absolute path can name any file the fleet's user can read. `~name/` (another user's home) is not supported; it is refused with a warning, never read as a directory called `~name`. Before this change it was the fleet process's current directory (`~/.agend` under the installed service, the shell's directory after a manual `agend fleet start`). For compatibility, a relative path whose file is missing under the working directory still falls back to the old fleet-directory file: the log names both paths and the instance's topic is told once. This fallback is still implemented in 2.2; move the file under the instance’s working directory to remove the warning.

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

Each kiro instance has its own kiro agent, `.kiro/agents/agend-<instance>-<fleet>.json` in its working directory, and resumes its own conversation by id, so kiro instances that share a working directory do not resume each other's conversation. The agent holds only this instance's AgEnD MCP server and its instructions. A **new** conversation runs as that agent, and AgEnD writes no shared entry for it. Its agent lists no resources (`resources: []`), but kiro still loads every `.kiro/steering/*.md` in the directory for every agent (verified on kiro-cli 2.21.0, 2.28.0 and 2.30.0, on each engine). So a new conversation also reads the steering files there: your own, and the AgEnD steering file of any other instance whose resumed conversation uses it (#1800, below). The agent also includes the workspace `.kiro/settings/mcp.json`. While another instance in the directory resumes a conversation, that file holds the other instance's AgEnD entry, and the new conversation sees that server too. A **resumed** conversation keeps the agent it was saved under and uses the shared entries while the switch is suspended (#1800, below). So server isolation is not guaranteed in a directory that has resumed kiro instances. The details are in the [design](design/kiro-per-instance-agent.md). It needs kiro-cli 2.21 or newer; an older one runs as before and says so when the instance starts.

- **Your own MCP servers stay.** The agent includes the global `~/.kiro/settings/mcp.json` and the workspace `.kiro/settings/mcp.json`. AgEnD writes its own entry there only while a resumed conversation needs it (below).
- **A resumed conversation keeps its saved agent (#1800).** kiro brings a resumed conversation back as the agent it was saved under. AgEnD used to type `/agent swap <agent>` into the pane to move it onto the instance's own agent. That switch is **suspended**, because an instance lost its AgEnD tools after it and could not `reply`. A resumed conversation now gets this instance's AgEnD server and instructions from the shared `.kiro/settings/mcp.json` entry and the steering file, as before #906, including for instances whose switch was already recorded.
- **When isolation applies.** With the switch suspended, isolation holds for conversations that started as the instance's own agent, and only until they are resumed. A resumed conversation uses the shared entries, so kiro sessions in that directory can see them again.
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

agy 1.1.0 and later accept working directories under hidden paths such as `~/.agend/workspaces/`, so an instance runs in its configured working directory like any other backend (the old redirect to `~/agend-workspaces/<instanceName>/` is gone). Fleet instructions are written as a marked block in `.agents/AGENTS.md` inside that directory.

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

With `skipPermissions: false`, the "Would you like to run the following command?" approval prompt is recognised as a permission interaction awaiting a human (#1715): deliveries are held while it is on screen, it appears in Needs-you, and AgEnD never auto-answers it. When a backgrounded task is running and `/quit` is issued, the "Local work is still active" confirmation menu is recognised and handled deliberately (#1716): deliveries are held, stop cancels the menu with Escape rather than answering an option, and the ended background work is reported to the instance's topic instead of being discarded silently. `/model` lists models from muse's own on-disk provider catalog, so newly released models appear after a restart without requiring a hard-coded update (#1796).

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
| `/web` (`/dashboard`) | Open web dashboard |
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

Fleet shutdown (`agend fleet stop`, `agend stop`) stops instances in parallel batches whose size scales with the fleet: 5 at a time for fewer than 10 instances, 10 for 10–30, and 15 for more than 30. The systemd unit bounds the whole stop with `TimeoutStopSec=300`, allowing several busy-Kiro batches; arbitrary fleet size or slow/stuck I/O can still exceed it. Detached restart uses the same five-minute grace. [Restart migration and custom timeout policy](cli.md#service-management) describe how existing units are handled.

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
that is what you want. The "update available" notice follows the same channel. A beta install is told only about
a newer beta: beta users stay on the beta line after a stable ships. An alpha install is told about a newer alpha
or a stable of a later minor, never about a beta.

The chat that asked for the update gets one message that follows it through the restart, ending in "✅ AgEnD updated
to vX; N/M agents running". On Telegram that message is edited at most every 6 s (a group allows a bot about 20
messages a minute, and every topic shares it with the fleet's other startup messages). When the last step can't land
during startup (a rate-limit window, the connection not up yet, or the network down), startup goes on and the final
step is retried for up to 30 minutes: edited in place, or posted as a new message if the old one can't be edited
(#2175, #2213). The same holds for the "Fleet ready" message of any start or restart, including a small fleet's. A
send that timed out on AgEnD's side may still have landed, so nothing else is sent until it settles: you never get it
twice.

A release is a pushed `v*` tag. The publish workflow maps it strictly: `vX.Y.Z` → `@latest`, `vX.Y.Z-beta.N`
→ `@beta`, `vX.Y.Z-alpha.N` → `@alpha`. Any other tag (an `-rc.N`, a typo) fails the job before anything is
built, and a stable older than the current `@latest` is refused. When a minor goes stable (2.2.0), point
`@alpha` at it too (`npm dist-tag add @songsid/agend@2.2.0 alpha`): an alpha install's `/update` then installs it, and the
notice says to run `/update`.

## PSS memory reporting

`agend ls` reports memory using PSS (Proportional Set Size) from `/proc/<pid>/smaps_rollup` instead of RSS. This avoids double-counting shared library pages across the process tree, giving a more accurate picture of actual memory consumption. Falls back to RSS on non-Linux systems.

## Host memory pressure

One fleet-wide sampler reads host memory every 30 seconds and before every spawn admission (startup, wake, restart and recovery). On **Linux** it uses PSI stall measurements plus RAM safety floors to throttle new CLIs, and never touches running ones:

- PSI `full avg10 ≥ 20%` is **critical**; `some avg60 ≥ 10%` or `full avg10 ≥ 5%` is **elevated**. The central [policy table](memory-pressure.md) documents all thresholds.
- available RAM below `max(300 MiB, 2% of RAM)`, or below `max(2 × that, 5% of RAM)` with swap at most 5% free → **critical**: no new CLI starts; the request waits and is retried after 5, 10, 20, 40 and then every 60 seconds;
- RAM below that second threshold, or (without PSI) RAM below twice that threshold together with swap at most 5% free → **elevated**: one start at a time, at least 5 seconds apart (an unreadable sample is treated the same way, never as zero RAM);
- after a critical hold clears, starts ramp back up slowly for 30 seconds.

`/health` always carries a `hostMemory` block (level, RAM and swap, trend; on Linux, PSI and the trigger), and pressure marks it degraded. On **macOS** the level is the kernel's own alarm (`kern.memorystatus_vm_pressure_level`: 2 slows, 4 holds), never the free-memory or swap numbers.

Host memory pressure sends no chat broadcast, including recovery. The Fleet
dashboard shows `host_memory`; logs and `/health` retain the measurements and
trigger. On Linux the three also name the largest processes in the fleet and
whose they are (an instance, the fleet, tmux) while pressure lasts (#2015), so a
runaway command can be found and stopped. A user action held by critical pressure gets the reason in its own
reply, or the web's HTTP 202 response, and continues when memory recovers.
Healthy RAM with cold swap remains normal under the Linux policy.

Details: [memory-pressure.md](memory-pressure.md).

## Fewer fleet stalls (2.3 beta, #1956)

The fleet runs on one event loop, so anything slow there holds up everything else: message delivery, tool calls and the dashboard. 2.3 beta removes the largest repeated costs. There is nothing to configure.

- **The dashboard's status:** codex's models cache is read once per version of the file instead of once per codex agent per update; each agent's statusline.json is read once per build; and the status is built once per 10-second heartbeat for every open tab, instead of once per tab.
- **tmux and stty commands** (message delivery, `/view`, window and session changes) are started by a small helper process, so the fleet no longer forks its own large process for each one: at 550 MB, about 26 ms on the loop per command became about 0.4 ms. A command is never run twice: if the helper is stuck or gone, a command it never started runs directly, and one it started fails the way a timed-out command always has.

## "Needs you" inbox (#1386 / #1398)

A single live **Needs you** message in each world's General topic surfaces attention items for that world's instances — delivery acknowledgements, hang alerts, permission prompts. Each General shows only its own world's instances (owner-scoped); the `/ui` web feed shows items fleet-wide. Every item is one tap from where it is acted on: the instance's own thread or the message's existing buttons. The only new interaction is **Acknowledge** for delivery items that have no button today. Items resolved on any surface disappear everywhere. In `/ui`, **Needs you** (`/ui/needs`) is a panel with a sidebar badge and optional desktop notifications (#1408 step 4). Design: [docs/design/1386-needs-you-inbox.md](design/1386-needs-you-inbox.md).

## Links to where a message sends you (2.2.5)

On Discord and Telegram, a message that sends you to another topic links to it (#1990).
- **What gets a link:**
  - a reply telling you to use General ends with a linked "→ General";
  - an instance's notices that point at General carry the same link;
  - General's notices that name an instance link the name to its topic;
  - cross-instance status lines link the other side.
- **How it looks:** on Telegram the link sits on the word; on Discord it is the channel mention.
- **Where there is none:** in a ClassicBot room, for another bot's instance, or in text that came from an agent or a pane.
- **Needs-you DMs:** they link into the group only for an admin who is a member (checked with the fleet's bot, cached 10 minutes). A public Telegram group's links use its @username.

## Web app shell (#1408)

`/ui` is rebuilt as a single-page Preact + htm app (no build step; Preact and htm are bundled alongside the source at `src/ui/shared/vendor/`). Step 1 delivers the **Chat** panel at `/ui/chat/<instance>` and the **Fleet** panel at `/ui/fleet`. Step 2 delivers the **View** panel at `/view` and `/view/<instance>`, and step 3 the **Settings** panel at `/settings` and `/settings/<section>`. Typography and layout are modelled on ChatGPT's web UI (design language only — no OpenAI code or assets). The chat thread remains a keyed DOM renderer mounted by a Preact component. Step 4 adds the **Needs you** panel at `/ui/needs`. Design: [docs/design/1408-app-shell.md](design/1408-app-shell.md).

Since then:
- **Fleet → Org chart** (`/ui/fleet/org`, #1389; a canvas from 2.2.5, #1918): General on top, then the teams in `fleet.yaml` order, then instances in no team, each card with its picture, identity colour, state and backend. A card opens its chat, and the sidebar's **Fleet** opens the chart the first time (then the Fleet tab used last on that device).
  - **Moving around:** drag to pan; zoom with the wheel, a pinch, the +/−/Fit buttons or `+ - 0`; an overview map jumps there. Clicking a team folds it to a count of its members by state. Find dims what does not match. **List** says the same in words. Nothing is edited here.
  - **Live traffic:** a line for each message between instances (`delegate_task`, `send_to_instance`, `report_result`, `request_information`, `broadcast`). It is dotted while queued, a moving dash while delivering, and fades over 12 s once delivered or read. A `delegate_task` stays drawn as work **in progress** until its `report_result` (same correlation id) comes back, then one line returns; with no report after 4 h it fades as **no report yet**. A broadcast to more than 8 (or any broadcast while zoomed out) becomes one line per team, ×N. It carries only the names, never message text, and leaves out instances with `cross_instance_visibility: hidden`. The public link shows it too, polled every 5 s. Since #2182 (2.3 beta) each line is routed from card to card around the cards and through gaps in the team borders by libavoid (`libavoid-js` 0.4.5, LGPL-2.1-or-later), in a worker that alone may run WebAssembly and can reach nothing; lines sharing a stretch are drawn apart.
- **Fleet → Cache** (`/ui/fleet/cache`, #1468): a per-instance prompt-cache expiry analysis with a keep-warm recommendation. It is read from local transcripts and priced at list price, and the check date is shown.
  - **From 2.2.5 (#2010):** it shows the mix of 5-minute and 1-hour cache writes and measures what a 5-minute cache really lasts. Each instance's gaps of 5 to 60 minutes over the last 7 days are counted, and with at least 10 such gaps:
    - where at most 10% rewrote the cache, it is simulated as 1 hour;
    - where at least half did, the card recommends `backend_options.claude-code.prompt_cache_ttl: "1h"` instead of keep-warm. That opt-in passes `CLAUDE_CODE_PROMPT_CACHE_TTL` on the instance's next start; unset, the CLI chooses.
  - **`get_cache_report`:** agents read the same report. General, coordinators and full-profile instances see every instance; any other instance sees its own row.
- **Fleet → Usage** (`/ui/fleet/usage`, 2.2.5, #2122): each agent's tokens, requests, delivered messages and API-equivalent at list price (not money spent), by agent, backend, model, credential profile or team, over today / 7 days / this month / all / custom days, with a daily trend, a calendar heatmap that tells idle days from days not collected, and a CSV of the same rows. Claude Code and Codex are measured (Codex's cache writes read "not reported"); the other CLIs are listed with the reason. Collected from fleet start and kept 400 days; agents read it with `get_usage_report`. The ◔ usage dialog links to it.
- **New agent** (2.2.5, #2074): a button at the end of the sidebar's list opens the Create agent dialog. With the sidebar collapsed, a **+** beside ☰ does the same; on a phone it is in the menu drawer. Only a session that may create agents sees it.
- **Filtering the sidebar** (2.2.5, #1936): the instance you have open stays on top under **Current**, matching or not.
- **Names that open an instance** (2.2.5, #1990): in a chat's cross-instance status lines the other instance's name opens its chat, and in a prompt card the instance's name opens its View. An agent's or a person's message never gets such a link.
- **The chat's commands and quick actions** (#1269): typing `/` runs the instance's own topic commands through the same handlers and command table. A paste over 4,000 characters is attached as a text file, and the thread stays at the newest message as content grows.
- **Log tab** (#1218): a per-instance **Log** panel shows each prompt, the agent's replies (never its thinking), every tool call with arguments and result, errors, and fleet events such as crashes or restarts. Steps are read on demand from the agent's transcript while the tab is open, and update live; secret values are masked and long text is truncated. Off by default (`web.log_tab`); a fleet admin enables it in Settings → Web, and it then appears over the public link too. Supported fully on claude-code and codex; other backends show fleet events only; kiro shows fleet events with a note explaining why its own steps are not yet available.
- **The composer's row** (2.3 beta, #2215): one row under the composer, at the bottom left: this browser's web authority, then the key hint (`✓ Verified · Enter to send · Shift+Enter for a new line`). When "Verified" ends is in its tooltip (on a touch screen, a tap shows it); not verified reads `Not verified · Authorize`. A guest's note and the public link's sentence share the same row.
- **The chat's identity card** (2.3 beta, #2217): nothing sits on the card. One card button in the chat header opens a menu with **Show card** and **Show picture and bio** (unticked, only the banner stays); both are kept on this device. Guests and the public link have the same button.
- **Apply from a verified browser** (2.3 beta, #2170): a web-verified browser's own **Apply** confirms a held Settings change when its account is on the change's platform and a fleet admin of every connection the change affects. No chat card is posted, General gets a notice, and every check runs again when the change executes. Guests, the public link, unverified browsers and changes that need the host CLI are unchanged.

See [web-dashboard.md](web-dashboard.md).

## Guest web sign-in (2.2.5)

**Off by default (#1920).** With it on, someone who is not a fleet admin can sign in to the dashboard as their own Discord or Telegram account and see only the agents they can already use in chat. **Settings → Web → Guests** turns it on and lists who signed in, and a guest's app shows only what a guest can use.

**Turning it on.**
- **Settings → Web → Guests** has:
  - the **Guest sign-in** and **Guests may chat** switches;
  - for each `open` connection, the agents its guests may reach;
  - every guest account: name, platform and id, the agents it reaches, its sessions and devices, last active, and **Narrow**, **Remove narrowing** and **Sign out**.
- **Applying changes:**
  - A change that widens what guests reach waits for a fleet admin's confirmation: turning it on, turning chat on, adding agents, or lifting a narrowing.
  - A change that narrows applies at once.
  - The card is disabled over the public link.
- **Or in `fleet.yaml`:**

```yaml
web:
  guests:
    enabled: true          # default false
    chat: true             # default true; false: guests only read
    open_instances:        # an `open` connection's guests reach only these (none by default)
      <connection id>: [helper]
    narrow:                # "<connection id>:<user id>": only takes away
      "<connection id>:123456789": [helper]
    session: { absolute_hours: 12, idle_minutes: 120 }   # 1–24 h, 15–720 min
```

**Getting a code.**
- **Asking:** the guest sends `/web`: typed in General or any fleet topic, as the slash command, or in a ClassicBot room (`/web@YourBot` in a Telegram group).
- **Delivery:** the code comes privately, by DM or as the slash command's private answer; it is never posted where they asked. On Telegram, if the bot cannot DM them yet, the reply links to the bot, and pressing **Start** there sends the code.
- **Limits:** one code per account, valid 5 minutes, one ask a minute.
- **Public link:** while an admin has the [public link](web-dashboard.md#reaching-it-from-elsewhere) open, the DM includes it and the code works there too. The admin who opened it is told in their General before the sign-in completes; if that cannot be posted, the sign-in is refused.
- **Notices:** every guest sign-in is posted in General.
- **Signing out:** a guest's own `/web revoke` ends only its sessions, code and remembered devices.

**What a guest reaches.** It is worked out on every request and never stored:
- **Its connection's agents:** the fleet topics and General, when that connection's access lets the account in (allowed or paired). On an `open` connection, only the agents named in `open_instances`.
- **Its own Telegram private ClassicBot room.**
- **A ClassicBot group room on its connection, while membership is verified:**
  - Telegram asks `getChatMember`.
  - Discord needs the person in the server, with View Channel and Read Message History there; for a private thread, also in the thread (or Manage Threads).
  - Answers are read in the background (at sign-in, when the guest's page connects, and again every 10 minutes). A room shows only on a "member" answer at most 15 minutes old. While a room is still being checked the page waits instead of signing the guest out.
- **Then `narrow`,** which only takes away.

A fleet admin is never a guest.

**What a guest can do.**
- **Chat:** with those agents only. That means the history its channel showed, files, reply buttons and Cancel, unless `chat: false` makes guests read-only.
- **No commands:** text starting with `/` is refused.
- **What the agent sees:** `[user:<name> via web (guest), id:<id>]`, for typed messages and button clicks alike. A guest only chats: the agent takes nothing they ask as an admin's.
- **Its app:** no Fleet, View, Settings, Needs you, New agent or widgets; a **Guest** chip says who is signed in.
- **Preferences:** it reads the host's look (theme, language) but no preference that names an agent, and it can set its own web name.

**Sessions.**
- **Lifetime:** 12 h absolute and 2 h idle by default (`web.guests.session`), never longer than the surface's own limit (the public link's 4 h / 30 min).
- **Caps:** at most 4 per account and 64 in all, counted apart from admins', so a guest never pushes an admin out.
- **Ending:**
  - a guest whose scope becomes empty is signed out;
  - turning guest sign-in off ends every guest session and forgets every guest's remembered devices, and turning it back on revives none.

## Instance identity in the web dashboard (#1630)

The sidebar, chat header and Needs-you list each show who an instance is. What stands for each instance is decided in this order: a picture uploaded for it in **View** → its own bot's avatar (when it has a dedicated bot; the primary bot counts when it serves only that instance, e.g. General) → the avatar of the bot it talks through (usually the General bot; the primary bot for an instance with no connection of its own) → its persona emoji → the first letter of its display name. A bot with no avatar set is skipped. **Remove picture** in **Edit profile** deletes an uploaded picture, so the next step shows again. An instance's own bot with a colour in its Discord server gets that colour as a ring around its picture. The status dot sits on the picture and labels the state (idle, working, looks stuck, paused, stopped, crashed, needs you) for screen readers as well as in colour. The chat header and the Needs-you list use the display name too. In the sidebar, when two instances share a display name, the instance name is shown under it.

Bot avatars and the custom emoji of the fleet's Discord servers are fetched on the host with the bot's own token, kept in `~/.agend/cache/` (refreshed at most once a day; a failed refresh keeps the last copy), and served by the dashboard to signed-in sessions, including the temporary public link, read-only. The page never loads images from Discord or Telegram. Discord server emoji in web chat are served the same way. The status-emoji editor in Settings uses the same cached route too, and the panels' content policy no longer allows any remote image source. In the Settings editor, an emoji from a server the fleet's bots are not in shows as its `:name:`.

Clearing the display name in View's **Edit profile** now removes the override — the name the agent set with `set_display_name` (or the instance name) shows again. Display names cleared before this release recover too.
## Agents' look on the web: themes, identity cards, widgets, custom CSS and mods (#1629)

Four things change how the dashboard looks, each with its own owner:

- **An agent's theme** (its own chat; from 2.3 beta, optionally the whole page while it is open: see [Page colours](#page-colours-23-beta-2196)): colours for light and dark, an accent, bubble corners and border, a font, a background picture, its own picture and ring colour, and the words it shows while working. The agent sets it with `set_web_theme` and `set_web_theme_asset`; a person can **Lock** or **Reset** it from the chat's or Details' **⋯** menu. While a viewer shows agents' themes, an agent's theme picture comes right after a picture uploaded in **View** in the identity order above.
- **An identity card** per instance: a portrait, a banner, a tagline and a bio, on Details, in View and folded into the chat. The agent sets its own; a person's field from **Edit profile** wins over the agent's, field by field.
- **Widgets**: small panels of facts (numbers, progress, a line of text, a list, a badge, a sparkline) drawn by the dashboard's own components from a short spec and values — never HTML, script or CSS. An agent places one in its own chat header and one on its own Details page with `set_web_widget`. Your own goes in the sidebar (Settings → Web appearance), with the fleet's counts.
- **Your own custom CSS** (Settings → Web appearance): a stylesheet for your own screens only.

What a viewer sees is theirs to choose: **Settings → Web appearance → Show agents' themes, effects and widgets** turns agents' themes and widgets off on all their devices, and `?safe=1` loads any page without themes or custom CSS. Agents can check how they appear with `get_web_appearance` and draw it with `preview_web_appearance`; the `web-appearance` skill walks them through it.

A **mod** is one file that carries such a look: a theme with its pictures, card text, widgets, effects (Canvas Worker effects are still 2.3 beta) and custom CSS. **Settings → Web appearance → Mods** imports one in two steps, showing everything in it first and applying only the parts you tick, all at once. Custom CSS from a file is never ticked for you. The same card exports a look as a file.

`web.themes.agent_edit: false` refuses every agent's appearance change; `web.appearance` sets the card's upload limits. An agent's changes are at least 30 s apart and at most 10 an hour.

**Uploads are not counted (2.2.5, #2083).** An agent's uploads (pictures, effects, proposed mods; effects are Canvas Worker, still 2.3 beta) are not counted. Each picture slot's size limits, the agent's picture quota and each file's own caps still apply.

**The Web appearance page (2.2.5, #2071)** groups its cards under five headings, each card with a **?** that opens its section of the guide. Over a public link it shows only a notice.
- **Look:** agents' themes on or off; identity colours, with a sample row; card size.
- **Your layout:** your sidebar widget.
- **Styles you write:** custom CSS, and turning it off on this device.
- **Add-ons:** mods, effects and your effect choices (Canvas Worker effects are still 2.3 beta).
- **Advanced:** card upload limits, and Restore defaults.

**Banner focus (2.2.5, #2086).**
- **Safe band:** a card's banner is never drawn wider than 5:1 (a wider screen centres it over a blurred copy) nor narrower than 9:4 (which crops the sides), so on a 1600×600 banner an area of about 1350×320, centred across the width, shows on every card size and layout. That area moves with the focus below; at the default focus, 50, it sits in the middle of the picture.
- **Focus:** 0 (top) to 100 (bottom), 50 by default, chooses which part of a tall picture shows. The agent sets `card.bannerFocus`, a person the slider in View's **Edit profile** (theirs wins), and General `set_web_settings`. The details are in [Web dashboard](web-dashboard.md): "Custom CSS", "Agents' themes", "Identity cards", "Widgets" and "Mods".

### Page colours (2.3 beta, #2196)

An agent's theme can colour the whole page, not only its chat, while that agent's chat, View, Log or Details is open: the sidebar, the header and the usage rail (on a phone, the drawer, the header and the bottom tabs). Open another agent and the page takes its look; open one without page colours, or anything else, and the page is in your own look again. Switching is instant, with no flash and nothing moving.

- **The agent turns it on** with `set_web_theme {"set": {"page": {"on": true}}}`, optionally with its own sidebar colour per mode (`page.sidebar.light` / `page.sidebar.dark`).
- **You decide per agent:** the chat's or Details' **⋯ → Page colours**: *the agent's choice* (the default), *on the whole page* or *only its chat*, kept for this host. General can set the same for you with `set_web_settings { what: "page_colours", instance, choice: "agent" | "page" | "chat" }`. Turning agents' themes off, or `?safe=1`, turns page colours off too.
- **For your own custom CSS (#2199):** while an agent's chat, View, Log or Details is open, `<body>` carries `data-agent="<its instance name>"`; elsewhere it has none. It switches in the same moment as the page, with or without agents' themes shown, so your stylesheet can follow the agent you are looking at: `body[data-agent="atlas"] { --bg-sidebar: #e2f0ed; }`.
- **Never themed:** fonts, pictures, CSS and the layout (page colours are colours only); AgEnD's status colours (the Needs you count, the state dots, errors, the focus ring); Settings; and every other agent's chat. A page theme is refused unless text, its accent and those status colours stay readable on its sidebar and background.
- **The header follows the page:** without page colours it is in your own look, even while the chat below it is themed.

The details are in [Web dashboard](web-dashboard.md), "Agents' themes".

### Ambient effects (2.2.5, #2117)

An agent can decorate its own chat with an **ambient effect**: falling petals, snow, rising lanterns, twinkling glyphs, or stars that scatter where you click. The agent sends only data, and the dashboard draws it. No agent code runs, so it needs no consent, preview origin or Try. The data is:
- a preset: `fall`, `rise`, `twinkle` or `burst-on-click`;
- up to 4 glyphs: short text such as 🌸 or ✦, or a small picture uploaded to the `glyph` slot;
- colours, and a few numbers (how many, how long, how big).

**Where it shows.**
- Behind the messages of that agent's chat. It never takes a click, a tap or focus.
- A click burst shows over the messages for a moment, and your click still lands on what is under it.
- A chat holds one looping effect and one click effect. At most 24 looping glyphs, and at most 3 bursts of 16 at once.

**Who sets it.**
- **The agent itself** (General too, since #2151) uses `set_web_ambient` and `clear_web_ambient`. That counts as a theme change: the same rate limit, and **Lock theme** stops it.
- **General, for the user**, uses `set_web_settings { what: "ambient", instance, ambient }`. The effect is recorded as the person's, so the agent can't change it afterwards.
- **A person** clears either kind from the chat's **⋯** menu (**Clear the ambient effect** / **Clear the click effect**). **Reset theme…** clears both.

**Reduced motion.**
- It plays even when your system asks for reduced motion.
- **Settings → Web appearance → Effects: follow the system's reduced-motion setting** keeps effects still on that device. It is per device and off by default.
- When the system asks for reduced motion and an ambient plays anyway, the chat says so once on that device, with **Turn off here**.

**When it doesn't show,** the chat's **⋯** menu says why, and choosing the line fixes it right there. The reasons:
- **Show agents' themes, effects and widgets** is off;
- this device follows reduced motion while the system asks for it;
- the page was opened with `?safe=1`.

**The public link** shows it, with the viewer's own switch. Clearing it is not offered there.

**Elsewhere:** mods carry it, `get_web_appearance` lists it, and `preview_web_appearance` draws it still. The `web-appearance` skill has the full spec.

### Owner effect preferences (2.3 beta)

The backend now keeps five owner effect selections (`fx.sidebar`, `fx.header`, `fx.page`, `fx.box`, `fx.cursor`) for
the signed-in web identity. Discord and Telegram identities stay separate; accounts are not merged. A web-only
`agend web --code` sign-in uses a **host-wide operator** bucket shared by everyone signing in as that operator.
Header tokens cannot read or write these five keys. Existing visible preferences remain host-wide, without migration;
profile and custom-CSS internal identity rules are unchanged. Settings → Web appearance offers the five selectors. With effects enabled, without HTML-preview consent or its listener, page/header/sidebar/box choices play across the supported stock panels in the same pool as Chat, with slot-specific Pause/Resume and unavailable/Clear controls. The cursor choice applies a static host PNG without HTML-preview consent, preserves explicit pointer/text/resize cursors and falls back while dragging or when unavailable. It runs no Worker code and consumes no frame slot.

Unsharing an effect revokes subsequent resource authorization for someone else's personal selection, including its
cursor image. The saved choice remains as unavailable until cleared, retaining its blob reference. This is stricter
than chat placements' retained-runtime policy: personal choices follow current sharing, while a chat keeps the exact
effect placed there. A reference never grants sharing or export authority. Unreadable preferences authorize no
personal effect and prevent collection. Playback independently rechecks stock trust/paint ordering;
agent front effects stay paused while custom CSS is active, loading or unknown (human placements keep their exemption).

Menus, dialogs and Keep/tour notices suppress foreground effects. Editable focus stops pointer signals, not unrelated drawing; protected controls remain clipped out, and keyboard events never reach a Worker. Behind effects still require
proven stock ordering; human placements do not bypass those gates. The Chat foreground status links to Appearance
to show the custom-CSS setting. See the [2.3 preview](whats-new-2.3.md); a trusted foreground plane is
a later 2.3.x follow-up (#1940).

### Chat effects and static posters (2.3 beta)

Canvas Worker layout refusals retain a local diagnostic code in Chat and the Effects dialog, and failed Try offers retain their stop code. The browser console also names them. Long conversations no longer exhaust the 128 paint-hole limit merely by containing off-screen controls; every marker is still inventoried and paint checks remain bounded. Agent summaries keep their closed reasons.

Signed-in Chat uses an opaque isolated bootstrap on the dashboard listener, without HTML-preview consent, a separate
preview port or a localhost requirement. Signed-in public/guest viewers can play current placements in chats they may
see; reads recheck their session/epoch, exposure and the exact placement. Library management, personal choices, private
images, Trial and profile routes remain closed to them. Public/guest Chat headers provide a browser-local show/off
switch and recovery on desktop and phone, without changing host settings. Other dashboard sessions use More → Effects
for local Pause/Resume and authorized Remove.

Effects start without an empty-page FPS calibration. The show switch, safe mode, hidden tabs, browser support and live
performance guard remain. **Effects: follow the system's reduced-motion setting** is device-local and off by default,
shared with ambient effects. An OS reduced-motion request alone does not block playback; data saver is informational.
A one-time chat note offers to follow the system; a motion refusal offers **Play effects anyway**, and safe mode offers
**Leave safe mode**. A poster can appear behind content when Worker/transport support or the chosen motion preference
prevents playback; no poster means no image. Public/guest viewers' show
choice stays in their browser and never changes host defaults. Safe mode, Show off and unknown stock ordering hide posters;
manual Pause, queues and failed live reads do not select fallback. Personal page/header/sidebar/box effects use the same pool;
the personal cursor uses a bounded static host image.

`preview_web_effect({id})` offers a volatile card in the agent's own web chat, using current own/shared read access. It makes no appearance write. Try is an admin-initiated sample inside a physically clipped host panel or sheet. Only an
explicit click by a signed-in admin on the non-public dashboard (not limited to localhost) may start it, with a visible Trial label and Stop control. Public links,
agents and header tokens cannot start it. Closing the panel, navigating, window blur or another menu/dialog stops
it. That click supplies consent for this sample without enabling global HTML previews. Host controls and the clipped
stage use a closed Shadow DOM with fixed styles and reset inherited typography; custom CSS stays active elsewhere.
The usual caps, profiler and safety stops remain, and ordinary foreground effects stay
suppressed. Offers last at most ten minutes, trials are session/epoch-bound, and each read rechecks the origin
agent's current own/shared access. No saved placement, claim, share or export is created. The volatile server
authority, local-admin API, host panel and shared app pool enforce this boundary. Cards are memory-only, expire in place and are never restored from disk. A valid late Start is only stopped, never mounted. Try uses manifest defaults and writes no saved profile record; mandatory safety history still applies. See the
[Try boundary](design/1629-effect-trial-authority.md).

A worked sample, [click-sparks](examples/click-sparks.md), shows a whole effect from `effect.json` to `upload_web_effect` and `apply_web_effect`: a burst where you click and a trail while you drag (512 px, 30 fps, 128 particles; #2043). A person can also choose it for the page or box slot.

### General changes Web appearance for you (2.2.5)

General, coordinators and full-profile instances can read and change Settings → Web appearance for the user with `get_web_settings` and `set_web_settings` (#2056). The change goes through the page's own store, checks and announcement, so every open page reads it again. One change per call:

- **Host settings:** agents' themes shown, card size and per-agent sizes, where identity colours show, colours off, the sidebar widget. `null` puts one back.
- **An agent's identity colour** (a preset or `#rrggbb`) and where it shows.
- **A banner's focus.**
- **A person's custom CSS** (`person`; the host operator by default): save (it goes on trial), keep, revert, switch to an earlier saved version, or off. The 64 KiB, no-remote-URL and `asset:` rules still apply (#2081).
- **A mod an agent proposed:** review, install the parts ticked (custom CSS is never ticked by itself), cancel, dismiss or uninstall. A mod the person imported from a file is theirs, and is refused.
- **Effects** (Canvas Worker effects, still 2.3 beta): apply or remove one on a chat, and a person's effect slots (sidebar, header, page, box, cursor).
- **An agent's ambient effect** (`what: "ambient"`): set one (it becomes the person's) or clear it.
- **Restore defaults:** the host settings and that person's custom CSS. This device's custom-CSS switch is left to the person.

What stays on the page: choosing a file from the person's computer (a mod, an effect folder, a CSS asset, a card picture), this browser's own switches (custom CSS off on this device, pausing playback), downloading an export, and the card upload limits. `get_web_settings` lists these as `page_only`. The `web-appearance` skill walks General through it.
