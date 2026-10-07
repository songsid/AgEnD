# AgEnD Roadmap

> Last updated: 2026-10-07 (2.2 line)
> Short and user-facing: what shipped, what is next.

## Shipped (v1.x)

Everything through v1.12: multi-backend coding CLIs, Telegram + Discord
channels, fleet orchestration with cron and cost guard, ClassicBot channels,
web dashboard with live monitoring, quickstart, Mirror Topic, full zh-TW
documentation. Details are in the CHANGELOG release sections.

## Shipped (2.0.x–2.1.x)

- 2.0.x: cancel/delivery-status UX, Discord adapter in core, `/save`,
  `/dashboard`, `/settings`, Web View overhaul, same-channel multi-bot
  ClassicBot, quickstart service install.
- 2.1.0–2.1.3: `/model`, auto-pause/wake + warm cap, Grok backend, one-shot
  schedules, Settings page, `/usage`, `/effort`, live progress, MCP
  auto-restart.
- 2.1.4: `/login`, `/install-cli`, `/clear`, `/steer`, `/btw`, `/tips`,
  Codex custom providers, full zh-TW interface.
- 2.1.5–2.1.9: fail-closed hardening, tool-profile defaults, Codex resume
  flows, delivery-status emoji config, session-lock screens, delivery worker.
- 2.1.10–2.1.12: short unique instance names with fleet-unique display
  labels, bounded session-head reads, reply-completion guard fixes, Discord
  defer/ack reliability, capacity detection hardening.

## Next: 2.2.0 — the web line

The dashboard becomes a first-class way to talk to the fleet:

- Sign-in with one-time codes, sessions with revoke.
- Chat-first UI: message input front and center, Markdown, uploads,
  delivery ticks, Stop.
- Health prompts mirrored between Telegram and web, single answer.
- Echo sync: web-typed messages appear in the instance's channel topic
  (fleet topics on, ClassicBot per-channel opt-in — see
  `docs/design/1320-classicbot-web-echo.md`).

## 2.2.1 — chat depth

- Inline HTML preview.
- Persisted, searchable chat history per instance.
- Step list: what the agent is doing, step by step.

## 2.2.2 — review flow

- Diff view and review comments.
- Kanban board for tasks.
- Timeline and export.

## 2.2.3 — code flow

- Per-task worktrees.
- PR flow: from task to pull request.

## Later

Slack channel, plugin system, multi-machine fleets — in that order of
likelihood. No dates; the web line ships first.

---

> **AgEnD is not another coding agent. It's the operations layer that makes
> coding agents work as a team.**
