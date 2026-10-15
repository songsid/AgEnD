---
title: CLI Reference
description: Every agend command, grouped by what you are trying to do.
---

`agend` manages the fleet from the machine it runs on. Everything here is local; day-to-day work happens in your chat app.

## Service

Start, stop, or restart the installed system service:

```bash
agend start
agend stop
agend restart
```

Update to the latest release and restart:

```bash
agend update
```

Pick a different target with `--beta`, `--alpha`, `--stable`, `--version 2.1.2`, or force a reinstall you already have with `--force`. Run from a fleet agent's session requires `--yes`; otherwise the command is refused.

Re-read `fleet.yaml` without restarting the fleet process:

```bash
agend reload
```

New instances start, removed ones stop, changed ones are reconfigured in place.

## Fleet

Start every instance, or one:

```bash
agend fleet start
agend fleet start <name>
```

Stop the same way:

```bash
agend fleet stop
agend fleet stop <name>
```

Restart gracefully — it waits for the agent to go idle first:

```bash
agend fleet restart
```

Restart a specific instance immediately (no idle wait — may interrupt a busy turn):

```bash
agend fleet restart <name>
```

That reuses the running code. To pick up a new version of AgEnD itself, restart the process:

```bash
agend fleet restart --reload
```

See what is running:

```bash
agend fleet status
```

Add `--json` for machine-readable output.

Show what the fleet has been doing — costs, session rotations, hangs:

```bash
agend fleet history
```

Narrow it with `--instance <name>`, `--type <type>`, `--since <date>`, `--limit <n>`, `--json`.

Show collaboration and tool calls instead:

```bash
agend fleet activity --since 2h --limit 200
```

`--format mermaid` prints the same activity as a sequence diagram.

Remove instance directories no config refers to any more:

```bash
agend fleet cleanup
```

Run it with `--dry-run` first if you want to see the list before anything is deleted.

## Instances

List instances with status, backend, team, context usage and last activity:

```bash
agend ls
```

`--json` for structured output, `--names-only` for one name per line.

Attach to an instance's tmux window — accepts the real name, the display label shown by `agend ls` (including CJK/emoji labels), or a fuzzy prefix; shows a menu with no argument:

```bash
agend attach <name>
```

Read the fleet log:

```bash
agend logs
```

`-n 100` for more lines (default 50), `-f` to follow, `--instance <name>` to filter.

Export a session as a self-contained HTML chat log:

```bash
agend export-chat --from <date> --to <date> -o <path>
```

## Diagnostics

Start here when something is wrong:

```bash
agend health
```

It reports the problems it finds rather than a bare status.

Deeper checks:

```bash
agend doctor
agend doctor mcp
```

`doctor mcp` covers IPC, config paths, duplicate servers, and whether each binary is on PATH.

Check a backend's environment — binary, auth, tmux, `TERM`:

```bash
agend backend doctor claude-code
```

Validate config before starting anything:

```bash
agend validate
```

## Web dashboard

Open the live dashboard and print a sign-in code:

```bash
agend web
agend web --code     # only print the code, no browser
```

`agend view` opens the read-only View panel.

Revoke every dashboard link and browser session at once:

```bash
agend web-token rotate
```

A running fleet picks that up with no restart.

### Setting up before a fleet exists

```bash
agend setup
```

It serves a form on the health port and prints two things:

```
Setup page: http://127.0.0.1:19280/s/8f3c…/
Setup code: K7QM-3XRD
```

The link is where the page lives, not permission to use it — the credential is the code you type in. Five wrong answers closes the page, and a replayed session cookie spends one of those five. The page closes itself when you finish, after 15 minutes, or after 10 minutes idle.

To set up from a phone:

```bash
agend setup --tunnel
```

It asks you to confirm every time, and refuses when there is no terminal to ask — no flag answers this in advance. **The bot token you type travels through Cloudflare's edge**, so set up from the machine itself if that is not acceptable. Without `cloudflared` installed the page stays on loopback and says so.

`--tunnel` cannot be combined with `--port`, and never binds the health port. When you finish, the page revokes its credentials, releases the port, stops the tunnel, and only then starts AgEnD.

`agend setup` refuses to run once a fleet is configured, and points at the dashboard's setup wizard instead. `agend setup --reset` is the only way back, and only from the machine.

## Schedules

List what is scheduled:

```bash
agend schedule list
```

Add one — cron expression, target instance, and message are all required:

```bash
agend schedule add --cron "0 9 * * *" --target myproject --message "daily standup"
```

`--label <text>` names it for humans; `--timezone <tz>` takes an IANA zone (default `Asia/Taipei`).

Change, enable, disable, or delete by id:

```bash
agend schedule update <id> --cron "0 10 * * *"
agend schedule enable <id>
agend schedule disable <id>
agend schedule delete <id>
```

See when a schedule last ran:

```bash
agend schedule history <id>
```

`agend schedule trigger <id>` currently prints guidance only — it does not execute a schedule.

## Settings confirmation

Sensitive config changes (from the web dashboard or Settings) become pending proposals. AgEnD first tries to prompt a fleet admin through the General instance (Confirm/Reject buttons in chat). If no matching General instance is available — for example when the change spans platforms or no General is reachable — it falls back to host CLI confirmation:

```bash
agend settings confirm <id>        # inspect the diff, then confirm
agend settings confirm <id> --yes  # confirm non-interactively after you have inspected
agend settings reject <id>
```

Run on the host as the same user as the fleet. Agent sessions cannot use this command.

## Topics and access

Bind an instance to a chat topic:

```bash
agend topic bind <name> <topic-id>
agend topic unbind <name>
agend topic list
```

Control who may talk to an instance:

```bash
agend access list <name>
agend access lock <name>
agend access unlock <name>
agend access pair <name> <user-id>
agend access remove <name> <user-id>
```

`lock` means whitelist only; `unlock` re-enables pairing.

## Setup and migration

```bash
agend quickstart
```

`agend init` is the full interactive wizard if you want every option.

Install as a system service (launchd on macOS, systemd on Linux):

```bash
agend install
```

`--no-activate` writes the service file without starting it. `agend uninstall` removes it.

Move to another machine:

```bash
agend export config.tar.gz
agend import config.tar.gz
```

`--full` includes all instance data, not just config.

## Shell completion

Tab-completes instance names for `agend attach` and `agend fleet start|stop|restart`:

```bash
agend completion install
agend completion status     # check that <TAB> will work in a new shell
```

On bash this writes `~/.local/share/bash-completion/completions/agend` and touches no rc file. On zsh it prints the line to add, because enabling it means editing `~/.zshrc` — pass `--modify-rc` to let it append that line for you.

`install.sh` runs this at the end (opt out with `AGEND_NO_COMPLETION=1`), and `agend update` refreshes files that are already installed without adding new ones.

zsh needs its completion system initialised first. If `autoload -Uz compinit && compinit` is not already in `~/.zshrc`, it must appear **above** the `agend` line.

Names come from `agend ls --names-only`, so completion offers exactly what `attach` accepts — including ClassicBot instances that exist only in `classicBot.yaml`.

## Chat commands

These run in the chat app. On **Discord** they work in any fleet-topic channel. On **Telegram**, commands that operate on the whole fleet — `/status`, `/sysinfo`, `/usage`, `/restart`, `/update`, `/doctor`, `/login`, `/web`, `/visibility` — are handled in the General topic only; in a worker topic they are refused. For the full command list with per-platform details and permissions, see [commands.md](https://github.com/songsid/AgEnD/blob/main/docs/commands.md).

| Command | What it does | Permission |
|---|---|---|
| `/status` | Fleet table: backend, model, context, effort, cost, state | 🔒 admin |
| `/sysinfo` | Version, load, IPC status, each backend CLI's version | All |
| `/usage` | AI subscription usage (one row per subscription) | All |
| `/ctx` | Agent context usage | All |
| `/steer <text>` | Interject into the current turn (claude-code, codex, grok, muse, kiro TUI) | All |
| `/btw <text>` | Side question without interrupting the current task (claude-code only) | All |
| `/compact` | Compact agent context | 🔒 admin |
| `/clear` | Full conversation reset (asks Confirm/Cancel) | 🔒 admin |
| `/model` | Switch backend model | 🔒 admin |
| `/effort` | Adjust AI reasoning effort | 🔒 admin |
| `/backend` | Move instance to another CLI backend | 🔒 admin |
| `/pause` | Pause an instance | 🔒 admin |
| `/wake` | Wake a paused instance | 🔒 admin |
| `/restart` | Restart every instance in place | 🔒 admin |
| `/update` | Update AgEnD to the latest version | 🔒 admin |
| `/doctor` | Fleet health diagnostics | 🔒 admin |
| `/login [backend]` | Remote CLI sign-in (installs the CLI if missing) | 🔒 admin |
| `/web` | Sign in to the web dashboard; `/web revoke` signs everyone out | 🔒 admin |
| `/collab` | Toggle bot/webhook message reception in a fleet topic | 🔒 admin |
| `/visibility` | How cross-instance messages appear in topics (full/summary/hidden) | 🔒 admin |
| `/tips` | Draw a random usage tip | All |

Everything else — creating instances, deleting them, handing out tasks — you ask the General instance for in plain language.

## Environment variables

| Variable | What it sets |
|---|---|
| `AGEND_BOT_TOKEN` | Telegram or Discord bot token. Use `bot_token_env` in `fleet.yaml` to read a different variable name. |
| `GROQ_API_KEY` | Groq key for voice transcription. Optional. |
| `AGEND_TMUX_SESSION` | tmux session name. Default `agend`. |
| `AGEND_HOME` | Data directory. Default `~/.agend`. |
