---
title: Features
description: What a fleet does once it is running.
---

A fleet is a set of independent agent sessions, one per project, that you reach from one bot. This page covers what they do without you.

## One bot, many projects

Each chat topic is one agent with its own project directory, backend, and conversation. Create a topic and the agent starts; delete it and the agent stops.

A message to a specific topic goes straight to that agent. A message to the **General** topic is read and routed to whichever agent should handle it, in plain language:

```
You: get the deploy script working on the staging box
General: → delegating to infra-agent
```

Instances run in tmux, so closing your terminal changes nothing.

## Agents that talk to each other

Every instance is a peer. There is no dispatcher in the middle — agents discover, wake, and message each other directly through MCP tools.

Three tools do most of the work:

- `request_information` — ask another agent a question and wait for the answer
- `delegate_task` — hand over work with success criteria
- `report_result` — return the answer, linked to the request that asked for it

Agents can also `create_instance`, `start_instance`, and `replace_instance` — but only with the `coordinator` tool profile. An ordinary worker can hand work to a peer and cannot spawn one. See [Tool profiles](/AgEnD/docs/configuration/#tool-profiles).

`create_instance` takes a `branch`, which puts the new agent in its own git worktree.

## Staying up without you

**Crash recovery.** When a CLI process dies, the daemon snapshots recent messages and tool activity, kills the whole process tree so no MCP server is orphaned, then tries `--resume` to restore the conversation. If resume fails it starts fresh and injects the snapshot as context.

Repeated crashes back off exponentially, and three crashes in five minutes stop the respawns entirely rather than looping.

If the tmux server itself dies, every instance loses its window at once. Two such crashes in five minutes pause all respawns for 30 seconds, so the fleet does not stampede.

**Hang detection.** An instance with no activity for 15 minutes (configurable) gets a notification with two buttons: force restart, or keep waiting. Detection reads both transcript activity and statusline freshness, so a long tool call is not mistaken for a hang.

**Instance replacement.** When a session is stuck in a loop or its context is polluted, `replace_instance` swaps it atomically: collect handover context, stop the old one, create a new one with the same config and the same topic, deliver the handover.

## Spending

Set a daily limit and the fleet enforces it:

```yaml
defaults:
  cost_guard:
    daily_limit_usd: 50
    warn_at_percentage: 80
    timezone: Asia/Taipei
```

You get a warning in the topic at the warn threshold, and at the limit the instance is paused and you are told. It resumes the next day, or when you restart it.

`/status` in the General topic shows where the money went:

```
🟢 proj-a — ctx 42%, $3.20 today
🟢 proj-b — ctx 67%, $8.50 today
⏸ proj-c — paused (cost limit)

Fleet: $11.70 / $50.00 daily
```

A summary of the same is posted daily at 21:00 by default.

## Rate limits

When the primary model is rate-limited, the next session restart moves to the next model you listed:

```yaml
instances:
  my-project:
    model_failover: [opus, sonnet]
```

You are told when it switches, and told again when it switches back.

Scheduled triggers defer themselves when the 5-hour rate limit is over 85% used. They are not lost — they fire on the next cron tick once there is headroom.

## Idle instances

`auto_pause_after` pauses an instance after it has been idle that many minutes. The tmux window stays, the CLI is suspended, and a message wakes it in about 30 seconds. An instance that is actively generating is never paused.

`warm_cap` caps how many instances are resident at once. When the count goes over, the least-recently-active **idle** instance is paused to make room — even if none has hit its own idle timer yet. General instances are never evicted.

```yaml
defaults:
  auto_pause_after: 30
  warm_cap: 15
```

## Scheduled work

Agents create their own schedules, backed by SQLite, and they survive restarts:

```
You: every morning at 9, check for open PRs that need review
Agent: → create_schedule(cron: "0 9 * * *", …)
```

When a schedule fires, the message arrives as though you had sent it. A schedule can target the agent that made it, or another one.

Manage them from the terminal with [`agend schedule`](/AgEnD/docs/cli/#schedules).

## From your phone

**Cancel button.** Every message carries an inline button that interrupts generation. Works on Telegram and Discord.

**Delivery status.** 👀 received → ⏳ processing → ✅ done, or ❌ failed. You can see where a message got to.

**Permission prompts** arrive as inline buttons — approve or deny a tool call without opening a terminal.

**Voice messages** are transcribed with Groq Whisper when `GROQ_API_KEY` is set.

## Discord

Two ways to use Discord. Forum-style topics work like Telegram's. Or use **ClassicBot**, which runs an agent in any ordinary text channel:

| Command | What it does |
|---|---|
| `/start` | Start an agent in this channel |
| `/chat <message>` | Talk to it |
| `/stop` | Stop it |

Restrict which servers may use it with `allowed_guilds` in `classicBot.yaml`; an empty list allows all. Changes are picked up every 30 seconds.

## Teams and templates

A **team** is a named group you can address at once:

```yaml
teams:
  reviewers:
    members: [reviewer-a, reviewer-b]
```

A **template** deploys several instances in one command, each in its own git worktree, optionally registering them as a team. Agents deploy them with `deploy_template` and tear them down with `teardown_deployment`.

A shared **task board** tracks multi-step work across instances, so one agent can see what another has finished.

## Watching and exporting

**Web dashboard** — `agend web` opens live fleet monitoring with SSE updates and a chat UI. `agend view` is the read-only version.

**Mirror topic** — point `mirror_topic_id` at a topic and cross-instance messages are mirrored there, so you can watch agents work without being in their topics.

**HTML export** — `agend export-chat` writes a session as a single self-contained file.

## Backends

| Backend | Notes |
|---|---|
| Claude Code | The most complete integration |
| OpenAI Codex | Native input queue; resumes sessions |
| Kiro CLI | `kiro_ui` chooses legacy, tui, or the v3 agent |
| Antigravity CLI | Runs in `agent_mode: cli` |
| Grok Build | |
| Meta Muse Code | Escape cancels; Ctrl+C quits |
| OpenCode | |
| Gemini CLI | Deprecated since 2026-06-18 |

OpenCode and Kiro CLI do not read the MCP server's `instructions` field, so fleet context and workflow templates are not injected into their system prompts. This is an upstream limitation.

## Extending

- **Webhooks** — POST on instance lifecycle events, with your own headers
- **Health endpoint** — HTTP on `health_port`, default 19280
- **External sessions** — a process outside the fleet can join over IPC and be messaged like any instance
- **Adapter plugins** — add a chat platform without changing AgEnD

## Limits

- macOS and Linux only. Windows is not supported; use WSL
- The official Telegram plugin in a global `enabledPlugins` causes 409 polling conflicts
- All backends run with permission checks skipped. Read the security notes before pointing one at something you care about
