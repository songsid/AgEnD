---
title: Features
description: What a fleet does once it is running.
---

A fleet is a set of independent agent sessions, one per project, that you reach from one bot — or from the browser. This page is the short version; each section links to the full reference in the repository's [`docs/`](https://github.com/songsid/AgEnD/tree/main/docs).

## One bot, many projects

Each chat topic is one agent with its own project directory, backend, and conversation. Create a topic and the agent starts; delete it and the agent stops.

A message to a specific topic goes straight to that agent. A message to the **General** topic is read and routed to whichever agent should handle it, in plain language:

```
You: get the deploy script working on the staging box
General: → delegating to infra-agent
```

Instances run in tmux, so closing your terminal changes nothing.

## The web dashboard

The fleet serves a dashboard on `127.0.0.1`, on `health_port` (default 19280). It is one app with a sidebar:

- **Chat** (`/ui`) — talk to any instance from the browser. It is the same conversation as its Telegram or Discord topic: what you send is echoed there as `🌐 <your name>: …`, and the agent's replies show in both. Files and images, **Stop**, and ticks showing how far each message got all work. Reply to a message with ↩ or R; a reply sent from the web is a native reply on Discord and Telegram too. A fleet with no chat platform at all can be run from the dashboard alone.
- **Fleet** (`/ui/fleet`) — the **Tasks** board (projects, main tasks and subtasks, with comments, dependencies and history), schedules and teams, an **Org chart** of General, teams and instances with their live state, which also has an **Office** view (the fleet drawn as a pixel-art office), a prompt-cache **Cache** analysis, and the fleet's config. **Docs** in its header opens this site.
- **Search** (Ctrl+K, or ⌘K) — finds chat messages, messages between agents and tasks, grouped by agent. In a chat, Ctrl+F searches only that agent. Only signed-in admins can search; the index keeps 90 days by default (`web.search.retention_days`).
- **Needs you** (`/ui/needs`) — everything waiting on you, from every bot, in one list: permission prompts, hang alerts, sign-ins, deliveries that could not be confirmed. Something handled anywhere leaves every list. Task Board cards that wait on you join it when `needs_you.task_board` is on.
- **View** (`/view`) — every agent's live terminal, the roster, AI subscription usage, and each agent's profile and avatar.
- **Log** — per instance: on Claude Code and Codex, each prompt, reply and tool call, read from the agent's transcript, plus fleet events such as crashes and restarts; other backends show the fleet events only. Off by default; a fleet admin turns it on in **Settings → Web** (`web.log_tab`).
- **Settings** (`/settings`) — agents, connections, ClassicBot, General and Web settings and the whole `fleet.yaml`, staged and applied together. Bot tokens are entered here and checked with the platform before anything is saved. Under **Web appearance** you also find the app icon (what **Add to Home Screen** shows) and the experimental Canvas Worker effects, which are off until you turn them on.

On a cold start or a full restart the dashboard opens before every agent has started, and shows each agent's progress.

**Signing in.** Send `/web` in General (fleet admins), or run `agend web` on the host, and type the one-time code on the sign-in page. A code works once and expires after five minutes. On the dashboard reached directly a session lasts 48 hours by default (configurable); one opened through the public link lasts at most 4 hours, ends after 30 minutes unused, and ends when the link closes. Signed in with a `/web` code, you are your Discord or Telegram account to the agent — for recognition only; it grants nothing.

**From a phone.** `/web` can also open a **temporary public link** through a Cloudflare Quick Tunnel: nothing is exposed until you choose it, the link and code come to you privately, and it closes after two hours by default (or with `/web revoke`). With your own domain (a named Cloudflare tunnel, set with `web.public_link.hostname`) the address stays the same every time, and it can stay open for up to seven days or until you close it. Whoever has it can use your chats, terminals, files and most of the dashboard — the public link only refuses a few changes (schedules, teams, Web settings, secrets) — so do not forward it.

Full guide: [web-dashboard.md](https://github.com/songsid/AgEnD/blob/main/docs/web-dashboard.md).

## Agents that talk to each other

Every instance is a peer. Agents discover and message each other through their permitted MCP tools; orchestration actions such as waking require the corresponding tool profile; General only routes what you send it.

Three tools do most of the work:

- `request_information` — ask another agent a question and wait for the answer
- `delegate_task` — hand over work with success criteria
- `report_result` — return the answer, linked to the request that asked for it

`delivery_status` tells an agent whether a message it sent was delivered. A shared **task board** (`Fleet → Tasks`) and fleet-wide **decisions** keep multi-step work in view. Agents are notified when a card is assigned to them, sent back, answered or confirmed, and each agent works on one card at a time. Only the cards you handed out wait for your confirmation; a card an agent handed out is confirmed by that agent.

Starting and replacing instances needs a tool profile that allows it: `coordinator` and `full` (and the General instance's own profile) can `create_instance` and `start_instance`, and only `coordinator` and `full` can `replace_instance`. An ordinary worker can hand work to a peer and cannot spawn one. See [Tool profiles](/AgEnD/docs/configuration/#tool-profiles).

`create_instance` takes a `branch`, which puts the new agent in its own git worktree.

## Buttons, polls and stickers

- **Reply buttons.** An agent's `reply` can carry 1–10 `buttons`. They appear on Telegram, on Discord and in the web chat; a click reaches the agent as `[button] <label>`. One choice answers for everyone, and the buttons then show who chose what. They expire after 24 hours and survive a restart.
- **Polls.** `reply` with `buttons` and `poll: { seconds, multi?, reveal?, show_voters? }` makes a timed vote (10 seconds to 24 hours). Everyone who may click may vote once and change their vote. At the deadline — or when the agent calls `close_poll` — the agent receives one `[poll results]` message with the counts and voters. AgEnD only counts; scoring a quiz is up to the agent.
- **Stickers and persona emoji.** Agents can list, preview and send Discord and Telegram stickers, and pick an emoji that stands for them as their "done" reaction.

Details: [Reply buttons and polls](https://github.com/songsid/AgEnD/blob/main/docs/features.md#reply-buttons).

## Staying up without you

**Crash recovery.** When a CLI process dies, the daemon snapshots recent messages and tool activity, kills the whole process tree so no MCP server is orphaned, then tries `--resume` to restore the conversation. If resume fails it starts fresh and injects the snapshot as context.

Repeated crashes back off exponentially, and three crashes in five minutes stop the respawns entirely rather than looping.

If the tmux server itself dies, every instance loses its window at once. The fleet treats that as one incident: respawns are held for 30 seconds after the first such crash, 2 minutes after a second and 10 minutes from the third, and no message is pasted into an instance until it has recovered.

**Hang detection.** When an instance's screen stops changing in the middle of a turn for 10 minutes (`hang_detector.timeout_minutes`), you get a notification with two buttons: **Force restart**, or **Keep waiting**. It is also listed in **Needs you**.

**Instance replacement.** When a session is stuck in a loop or its context is polluted, `replace_instance` swaps it atomically: collect handover context, stop the old one, create a new one with the same config and the same topic, deliver the handover.

**After an upgrade**, each existing instance gets one short what's-new notice before its next message, listing the agent-facing changes, so a resumed session knows about tools that changed under it.

## Backends, models and logins

- `/model` and `/effort` change an instance's model and reasoning effort from a menu.
- `/backend` moves an instance to another CLI backend installed on the host: backend → model → effort → confirm. The instance restarts once, in a fresh session — a conversation does not carry across backends.
- `/login` signs a backend CLI in (and installs it if missing) without SSH: a device code in the chat for Codex and Grok, a one-time browser terminal for Claude Code and Kiro CLI.
- **Credential profiles** give an instance its own login — a second subscription — for Kiro CLI, Codex and Claude Code (`backend_options.<backend>.credential_profile`). `/usage` and the dashboard show one row per subscription.

Details: [commands.md](https://github.com/songsid/AgEnD/blob/main/docs/commands.md), [credential profiles](https://github.com/songsid/AgEnD/blob/main/docs/configuration.md#credential-profiles-multiple-subscriptions-of-one-backend).

## Spending

Set a daily limit and the fleet enforces it:

```yaml
defaults:
  cost_guard:
    daily_limit_usd: 50
    warn_at_percentage: 80
    timezone: Asia/Taipei
```

You get a warning in the topic at the warn threshold. At the limit the instance is stopped and its topic is told; start it again to continue.

`/status` in the General topic shows where the money went:

```
| Instance | Backend | Model | Ctx | Effort | Cost | State |
```

One row per instance. State combines paused, stopped or crashed with what the instance is doing.

A summary of the same is posted daily at 21:00 by default.

## Rate limits

List a backup model and the fleet switches to it when the primary runs short:

```yaml
instances:
  my-project:
    model_failover: [opus, sonnet]
```

When the 5-hour usage reaches 90%, the next launch uses the backup model; once it is back under 50%, the primary returns. You are told both times.

Scheduled triggers defer themselves when the 5-hour rate limit is over 85% used. A deferred run is retried once, after the window resets — never twice, and never past the schedule's next regular run.

## Idle instances

`auto_pause_after` pauses an instance after it has been idle that many minutes. The tmux window stays, the CLI is suspended, and a message wakes it in about 30 seconds. An instance that is actively generating is never paused.

`warm_cap` caps how many instances are resident at once. When the count goes over, the least-recently-active **idle** instance is paused to make room — even if none has hit its own idle timer yet. General instances are never evicted.

```yaml
defaults:
  auto_pause_after: 30
  warm_cap: 15
```

Both are off (`0`) unless you set them.

## Scheduled work

Agents create their own schedules, backed by SQLite, and they survive restarts:

```
You: every morning at 9, check for open PRs that need review
Agent: → create_schedule(cron: "0 9 * * *", …)
```

When a schedule fires, the message arrives as though you had sent it. Every agent can schedule for itself — heartbeats, reminders, "check back in 30 minutes" — and can change or remove the schedules it made for itself. Scheduling work for another agent, or changing a schedule someone else set, takes a coordinator (`coordinator`, `general` or `full`); a `minimal` agent has no schedules at all.

Manage them from the terminal with [`agend schedule`](/AgEnD/docs/cli/#schedules), or in the dashboard under **Fleet → Schedules**.

## From your phone

**Cancel.** When a message is delivered to an agent, a 🛑 Cancel button is posted in its topic or channel. It interrupts the generation and, after 30 seconds, also shows how long the agent has been working. `/cancel` does the same. The web chat has **Stop**.

**Steer.** `/steer <message>` interjects into the agent's current turn instead of waiting for it to finish (Claude Code, Codex, Grok, Muse and verified Kiro TUI versions; unsupported launches refuse `/steer`; send a normal message instead); `/btw <message>` asks a side question without interrupting (Claude Code).

**Delivery status.** A reaction on your message shows where it got to. On Discord: 👀 received, ⏳ queued, ✅ delivered, ❌ failed. Telegram accepts fewer reactions, so it shows 👀 until delivery and 👎 if it fails. Both are configurable with `status_emojis`.

**Permission prompts** arrive as inline buttons — approve or deny a tool call without opening a terminal.

**Voice messages** are transcribed with Groq Whisper when `GROQ_API_KEY` is set.

## Discord

Two ways to use Discord. Forum-style topics work like Telegram's. Or use **ClassicBot**, which runs an agent in any ordinary text channel:

| Command | What it does |
|---|---|
| `/start` | Start an agent in this channel |
| `/chat <message>` | Talk to it |
| `/stop` | Stop it |

A ClassicBot admin can start one directly. Anyone else needs their server listed in `defaults.allowed_guilds` in `classicBot.yaml`; otherwise — including when the list is empty — the start asks General for approval. Changes are picked up every 30 seconds.

## Teams and templates

A **team** is a named group you can address at once:

```yaml
teams:
  reviewers:
    members: [reviewer-a, reviewer-b]
```

A **template** deploys several instances in one command, optionally registering them as a team. Pass a `branch` and each gets its own git worktree. Without one, every role would use the same project directory: the second is refused as a duplicate and the whole deployment is rolled back, so a template with several roles needs `branch`. Agents deploy them with `deploy_template` and tear them down with `teardown_deployment`.

## Watching and exporting

**Dashboard** — see [above](#the-web-dashboard). `agend web` signs you in from the host; `agend view` opens `/view`.

**Mirror topic** — point `mirror_topic_id` at a topic and cross-instance messages are mirrored there, so you can watch agents work without being in their topics.

**HTML export** — `agend export-chat` writes the fleet's activity over a date range (`--from`, `--to`) as one self-contained HTML file.

## Updating

`agend update` (or `/update` in chat) installs the newest version on the channel you are on — stable, `--beta` or `--alpha` — and restarts the fleet. See [Beta and alpha update channels](https://github.com/songsid/AgEnD/blob/main/docs/features.md#beta-and-alpha-update-channels).

## Backends

| Backend | Notes |
|---|---|
| Claude Code | The most complete integration |
| OpenAI Codex | Native input queue; resumes sessions |
| Kiro CLI | `kiro_ui` chooses legacy or tui; v3 is not supported yet |
| Antigravity CLI | MCP by default; `agent_mode: cli` to use agend-agent commands |
| Grok Build | Needs Grok CLI 1.0.13 or later (`grok update`) |
| Meta Muse Code | Escape cancels; Ctrl+C quits |
| OpenCode | |

Every backend gets the full fleet instructions through its own route (a system-prompt file, `AGENTS.md`, its agent config); the MCP server's `instructions` field carries only a compact contract. See [Fleet instructions and session context](https://github.com/songsid/AgEnD/blob/main/docs/configuration.md#fleet-instructions-and-session-context).

## Extending

- **Webhooks** — POST to your URL, with your own headers, on hangs, MCP or terminal failures, cost warnings and limits, deferred schedules, and model failover
- **Health endpoint** — HTTP on `health_port`, default 19280
- **External sessions** — a process outside the fleet can register an IPC identity and use permitted tools; registration does not prove inbound delivery into its own CLI conversation
- **Adapter plugins** — add a chat platform without changing AgEnD

## Limits

- macOS and Linux only. On Windows, use WSL — the [Windows installer](/AgEnD/install-windows/) sets it up
- The official Telegram plugin in a global `enabledPlugins` causes 409 polling conflicts
- Agents run with permission checks skipped unless you set `skipPermissions: false` for an instance — except Antigravity, which always launches with `--dangerously-skip-permissions`. Read the security notes before pointing one at something you care about
