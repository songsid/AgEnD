# CLI Reference

## Chat commands (Telegram fleet menu / Discord slash)

The Telegram fleet menu lists 23 commands; the ClassicBot menu lists 11. Discord registers 29 slash names. `/web` is the primary command; `/dashboard` stays listed as deprecated (menu/slash description “Deprecated — use /web”) and still runs `/web` after a one-line notice. `/cancel` and `/save` are also handled when typed on Telegram, outside its menus. 🔒 requires an admin for that scope; see [commands.md](commands.md) for the owning fleet/ClassicBot roles and platform details. The menus and locks come from `src/command-table.ts`.

| Command | Description | Options / args | Permission |
|---------|-------------|----------------|------------|
| `/status` | Fleet table with Backend, Model, Ctx, Effort, Cost and State columns | — | 🔒 admin |
| `/sysinfo` | Show detailed system diagnostics (version, load, IPC status, each backend CLI's version); also `/sys-info`, `/sys_info` on Telegram | — | All |
| `/web` (`/dashboard` alias) | Open the web sign-in menu, then press a login button to get a private one-time code. Discord uses DM with an ephemeral fallback; Telegram DM refusal explains how to start the bot privately. `/web revoke` (on Discord, the `action: revoke` option) signs every browser out. `/dashboard` is listed as deprecated and prints a notice, then does the same | `[revoke]` | 🔒 admin |
| `/backend` | Switch a fleet instance’s backend; ClassicBot uses Settings or `classicBot.yaml` | Backend name or menu | 🔒 admin |
| `/visibility` | Set cross-instance message visibility | `full\|summary\|hidden`; Telegram General only | 🔒 admin |
| `/profile` | Record the running fleet’s CPU profile in General (default 60 s, max 1,800 s) | `[seconds]` | 🔒 admin |
| `/ctx` | Show agent context usage | — | All |
| `/compact` | Compact agent context | `[instructions]` — steers the summary, Claude Code only | 🔒 admin |
| `/steer` | Interject into the agent's current turn instead of queueing for idle | `<message>` required; `claude-code`/`codex`/`grok`/`muse`, and `kiro-cli` on its verified TUI ([details](commands.md#steer-btw-and-clear-backend-support)) | All |
| `/btw` | Side question without interrupting the current task | `<message>` required; `claude-code` only | All |
| `/clear` | Full conversation reset (destructive — asks Confirm/Cancel) | — | 🔒 admin |
| `/model` | Switch backend model | Name or inline keyboard/select menu | 🔒 admin |
| `/effort` | Adjust AI reasoning effort | `low\|medium\|high\|xhigh\|max`, or menu with no arg | 🔒 admin |
| `/pause` | Manually pause an idle instance | `[instance]` — required in General | 🔒 admin |
| `/wake` | Wake a paused instance | `[instance]` — required in General | 🔒 admin |
| `/restart` | Restart all instances in-process (no process exit) | `[full]` / `mode: full` reloads the entire fleet process and adapters | 🔒 admin |
| `/collab` | Toggle bot/webhook message reception | — | 🔒 admin (not handled in Telegram ClassicBot) |
| `/update` | Update AgEnD to the latest version on the installed channel | — | 🔒 admin |
| `/doctor` | Run fleet health diagnostics | — | 🔒 admin |
| `/login` | (beta) Remote CLI sign-in, installing the CLI first when missing | `[backend] [cancel]`; `/login cancel` anytime | 🔒 admin |
| `/usage` | Show AI subscription usage | — | All |
| `/tips` | Draw a random usage tip where you ran it | `[mode]` — `on\|off` toggles the daily auto-send, `advanced on` unlocks the advanced tier (both admin) | All for a draw |

All other operations (create/delete/start instances, delegate tasks) are handled by the General instance through natural language.

## Service management

```bash
agend start                     # Start installed service; with no service, start a detached fleet
agend stop                      # Stop AgEnD service
agend restart                   # Restart AgEnD service through its manager (systemd unit, launchd job, or detached)
agend restart <name>            # Restart one instance now; the fleet keeps running
agend update                    # Update on the installed channel (an alpha stays on alpha, a beta on beta) and restart
agend update --alpha            # Install from the alpha channel (previews of the next minor)
agend update --beta             # Install from the beta channel
agend update --stable           # Install from the stable channel, even from a beta (may go back a version)
agend update --version 2.1.9    # Install a specific version
agend update --force            # Force reinstall and restart even when already up to date
agend reload                    # Hot-reload config (sends SIGHUP to fleet process)
```

When the new release's service does not come up after an update (its restart or start fails, or, on macOS, its fleet does not start running under launchd), the update rolls back: the previous package, its systemd unit or launchd plist and the previous service come back, and the update says so and exits 1 (#2420).

To roll back, the update first copies the installed AgEnD next to it, under `<npm prefix>/.agend-rollback/`, on a host with a service. That needs as much free space on the npm prefix's disk as the installed AgEnD takes with its bundled Node, about 235 MB. Without it the update changes nothing and says:

```
✗ Not updating: the installed AgEnD could not be copied aside for a rollback (ENOSPC, No space left on device '…/.agend-rollback/…'). Nothing was changed
```

Free some space and run it again. The copy is removed when the update ends. One left by an update that was killed is removed by the next one. A rollback that could not finish keeps its copy on purpose, names it in its message and leaves a `kept.txt` in it; remove that directory yourself once you no longer need it.

`agend reload` re-reads `fleet.yaml` and reconciles instances: new instances are started, removed instances are stopped, and changed configs are applied — without restarting the fleet process.

### Who stopped the fleet

`agend stop`, `agend restart`, `agend update` and `agend fleet stop` (without an instance name) affect every instance, so each one writes a line to `restart-audit.log` in the AgEnD home **before** it acts: the time, the command, the chain of parent processes with their command lines, the working directory, whether stdin was a terminal, and `AGEND_INSTANCE_NAME` when it ran inside a fleet agent's session. Instance-level `fleet stop <name>` / `restart <name>` are recorded too. When the fleet receives the resulting signal it names that request in its own log, so an unexpected restart can be traced even though `fleet.log` is rewritten by the restart.

Started from a fleet agent's session (`AGEND_INSTANCE_NAME` is set, and is inherited by everything the agent runs — including a `$(...)` or backtick inside a quoted argument), those commands are refused unless you add `--yes`; the refusal is recorded as well. From a test runner (`VITEST` / `NODE_ENV=test`) they are refused outright; `AGEND_ALLOW_TEST_FLEET_CONTROL=1` lifts that for a test that really targets a scratch fleet. `/update` and `/restart` sent by a fleet admin are recorded with who sent them.

## Fleet management

```bash
agend fleet start               # Start all instances (manual mode); with a service installed, runs `agend start`
agend fleet start <name>        # Start a specific instance
agend fleet stop                # Stop all instances; with a service installed, runs `agend stop`
agend fleet stop <name>         # Stop a specific instance
agend fleet restart [<name>]    # Deprecated, removed in 2.4: runs `agend restart [<name>]` (--reload is ignored)
```

On a host with an AgEnD service installed (a systemd user or system unit, or the launchd job), `agend fleet start` and `agend fleet stop` run by hand hand over to `agend start` / `agend stop` and say so, so the service manager keeps owning the fleet: no second, unmanaged fleet beside the service, and no stop that systemd undoes (#2356). The service manager's own `fleet start` (the unit's `ExecStart`, the launchd job) and hosts without a service (Docker, manual setups) start the fleet directly as before. With an instance name (`fleet start <name>`, `fleet stop <name>`) nothing changes. `agend stop` also stops a system unit (`agend.service`). When the installed service cannot run on this host (it was written but never activated, or launchd has no session for it), `agend start` refuses to start a fleet beside it and says so; `agend fleet start --direct`, from your own shell (never an agent session), starts the fleet without the service. The fleet's own lock still refuses a second fleet on the same AgEnD home.

```bash
agend fleet history             # Show event history (cost, rotations, hangs)
agend fleet history --instance <name> --type <type> --since <date> --limit <n> --json
agend fleet activity            # Show activity log (collaboration, tool calls, messages)
agend fleet activity --since 2h --limit 200 --format text
agend fleet activity --format mermaid  # Output activity as Mermaid sequence diagram
agend fleet cleanup             # Remove orphaned instance directories
agend fleet cleanup --dry-run   # Preview cleanup without deleting
```

`agend fleet status` is a hidden alias of `agend ls --resources`. `agend fleet logs` was removed; use `agend logs`.

## Instance tools

```bash
agend ls                        # List instances with status, backend, team, context, activity
agend ls --json                 # JSON output
agend ls --names-only           # Names one per line (used by shell completion)
agend ls --resources            # Also workspace disk, unregistered dirs, and host memory/swap
agend ls --running              # Running instances only
agend ls --team <name>          # Filter by team
agend ls --backend <name>       # Filter by backend
agend ls --display              # Add display names as last column (hidden by default)
agend attach [name]             # Attach to instance tmux window (accepts real name, display name, row number, or substring)
agend logs                      # Show fleet log (daemon.log, or fleet.log if the daemon log is not there yet)
agend logs -n 100               # Show last 100 lines (default: 50)
agend logs -f                   # Follow mode (tail -f)
agend logs --instance <name>    # Filter by instance name
agend export-chat               # Export fleet activity as HTML chat log
agend export-chat --from <date> --to <date> -o <path>
agend profile [seconds]         # Record the running fleet's CPU profile (local operator; default 60, max 1800)
agend delivery show             # Read a durable delivery status (operator; the query is audited locally)
```

`agend status` is a hidden alias of `agend ls` (already-shipped update and Windows-shortcut messages still say `agend status`).

`agend logs` reads `~/.agend/daemon.log`, which holds the fleet's runtime logs.
Service stdout/stderr remains in `~/.agend/fleet.log` for startup errors and Node
warnings; inspect that file if the service cannot start. If `daemon.log` does
not exist yet, `agend logs` falls back to `fleet.log`. Structured logs are also
shown on stdout when running interactively in a terminal.

## Shell completion

Tab-completes instance names for `agend attach` and `agend fleet start|stop|restart`,
and subcommand names elsewhere.

```bash
agend completion install        # Recommended: set it up automatically
agend completion status         # Check that <TAB> will actually work in a new shell
agend completion bash           # Print the bash script
agend completion zsh            # Print the zsh script
```

`completion install` detects your shell(s) and does the least invasive thing
that works:

- **bash** — writes a static file to
  `~/.local/share/bash-completion/completions/agend` (system dir when root).
  No rc file is touched, reruns are idempotent, and there is no shell-startup
  cost — bash-completion lazy-loads it on first `<TAB>`. That file is only
  read when **bash-completion** is loaded in your shell (Ubuntu/Debian do this
  by default; macOS's bash and minimal containers do not). `install` checks a
  real interactive bash and, when bash-completion is not loaded, says so:
  rerun with `--modify-rc` to add a marker-guarded line to `~/.bashrc`
  instead (added at most once), or install bash-completion.
- **zsh** — prints the one-liner to add, because enabling it means editing
  `~/.zshrc`. Pass `--modify-rc` to let it append a marker-guarded line for
  you (added at most once). Root installs write
  `/usr/share/zsh/site-functions/_agend` instead and skip the rc entirely.

The installer runs automatically at the end of `install.sh` (opt out with
`AGEND_NO_COMPLETION=1`; authorize the rc line with `AGEND_MODIFY_RC=1`)
and is offered during `agend quickstart`. `agend update` refreshes
already-installed completion files so they track the new version's commands —
it never installs anything new. Until something is installed, `agend ls` ends
with a one-line tip pointing here. After installing, open a new terminal.

Manual alternative — add one line to your shell rc file:

```bash
# bash — ~/.bashrc
echo 'eval "$(agend completion bash)"' >> ~/.bashrc

# zsh — ~/.zshrc (needs compinit; see below)
echo 'eval "$(agend completion zsh)"' >> ~/.zshrc
```

Then reload the shell (`exec $SHELL`) and try `agend attach age<TAB>`.

zsh requires the completion system to be initialised first. If it isn't already,
`autoload -Uz compinit && compinit` must appear **above** the `eval` line in `~/.zshrc`.

Names come from `agend ls --names-only`, so completion offers exactly the instances
`attach` accepts — including ClassicBot instances that only exist in `classicBot.yaml`.
Each TAB press runs that command (~90ms).

## Diagnostics & validation

```bash
agend doctor                    # Host/setup diagnostics (backends, tmux, service, D-Bus, fleet, IPC, network)
agend doctor mcp                # Fleet-wide MCP health check (IPC, config paths, duplicates, binary PATH)
agend health                    # Live health of a running fleet (HTTP, tmux, IPC); not a substitute for doctor
agend validate                  # Validate fleet.yaml and classicBot.yaml
agend validate --connections    # Print CONNECTIONS=<n>: chat connections in fleet.yaml (for scripts)
agend backend doctor [backend]  # Check backend environment (binary, auth, tmux, TERM)
agend delivery scan-forged-envelopes --instance <name>  # Check a kiro instance's transcript for peer envelopes the fleet never delivered (--all, --json)
```

## Web Dashboard

```bash
agend web                       # Print a one-time sign-in code and open the sign-in page
agend web --code                # Only print the sign-in page and code (no browser)
agend view                      # Open the read-only View dashboard in browser
agend web-token rotate          # Sign every browser out and rotate the CLI token
agend setup                     # Guided setup page, before a fleet exists
agend setup --reset             # Allow setup to run again after it completed
agend setup --tunnel            # …and expose it publicly, so a phone can open it
```

`agend setup` serves a small form on the health port and prints **two** things:

```
  Setup page: http://127.0.0.1:19280/s/8f3c…/
  Setup code: K7QM-3XRD
```

The link is where the page lives, not permission to use it — the random path
only means nothing finds the page by looking for it. The credential is the code,
typed into the page. Keeping the credential out of the URL is what stops a
forwarded message, a shell history or a chat client's link preview from carrying
the whole thing; a preview fetch of this link gets a box to type into and
nothing about your machine.

Five wrong answers closes the page, and that budget is shared: a wrong code and
a replayed session cookie both spend one. A wrong path does not — otherwise
anyone who found the host could close your setup page without ever finding it.

The page closes itself when you finish, after 15 minutes, or after 10 minutes
idle — a setup form left open is a surface nobody is watching.

**Web only (no bot)** (#2233) is the third choice next to Telegram and Discord: no
bot token, no admin ID, nothing to verify. It writes the first agent and no chat
connection, so AgEnD is used from its web dashboard (sign in with
`agend web --code` on the machine), and backend CLIs are signed in there too
(Settings → Agents → Sign-ins). Discord or Telegram can be added later from
Settings. The host confirmation (`agend settings confirm <id>`) is the same.

### Setting up from a phone

`agend setup --tunnel` asks you to confirm first, every time — there is no flag
and no setting that answers it in advance, and a run with no terminal is refused
rather than assumed to be consent. The confirmation says what you are agreeing
to: the bot token you type into the page travels through Cloudflare, anyone who
sees the link can get the code wrong five times and close your setup page, and
so you should not paste it into a group chat.

After you agree it puts the page behind a Cloudflare quick tunnel and prints
an `https://…trycloudflare.com/s/…/` link instead of the loopback one. The code
still comes from the terminal and is still what authorises you; the tunnel is
transport and nothing else. Traffic passes through Cloudflare, so **the bot
token you enter is seen by Cloudflare's edge** — if that is not acceptable, set
up from the machine itself.

`--tunnel` cannot be combined with `--port`, and in tunnel mode the page **never
binds the health port**, not even the one in your `fleet.yaml`: the health port
is what AgEnD itself binds afterwards, and a tunnel that outlived setup would
otherwise be pointed at the dashboard.

When you finish, the page revokes its own credentials, closes its listener, and
only then stops the tunnel and starts AgEnD. If the tunnel cannot be confirmed
stopped, AgEnD still starts — the leftover tunnel points at a port nothing will
bind again — but the message says so, names the process to kill, and no further
tunnel is opened until it is resolved. It never claims the tunnel closed safely
when it does not know that.

With no `cloudflared` on the machine the page stays on loopback and says so,
rather than handing you a link a phone cannot open.

It refuses to start while AgEnD is running, and a fleet refuses to start while
it is open: both hold `fleet.lock`, which now records which kind of process owns
it. When you finish, the page releases the port **before** AgEnD is started, so
the two never contend for it; the browser sees connection refused for a few
seconds and then the fleet answers.

Setup being complete is recorded in its own file, not inferred from fleet.yaml
existing — deleting the config must not reopen a setup page. A fleet that comes
up on a config with agents in it records the marker too, so an installation that
predates the marker is not treated as unconfigured. `--reset` is the only way
back, and it is a local command.

The page is for an installation that has no agents yet. With agents configured
it refuses and points at the dashboard's setup wizard, which edits fleet.yaml in
place — this page writes the file by dumping the loaded configuration, which is
right for a file it creates and would flatten comments and freeze defaults in
one somebody already has.

A user guide to the whole dashboard (panels, chat, files, Stop, sessions, reaching it from elsewhere) is in
[web-dashboard.md](web-dashboard.md).

### Dashboard sign-in and sessions

Send `/web` in General and press **💻 AgEnD computer: get a code** (or choose the temporary public option for another device). The private packet includes the page and code; `agend web --code` does the same on the host. The newest code works once for five minutes.

- Direct dashboard sessions default to 48 hours, configurable with `web.session.local.*`. A public-link session ends after at most four hours, 30 minutes idle, or when the link closes.
- `/web revoke` signs every browser out and withdraws unused codes; `agend web-token rotate` also replaces the header token.
- A code or session grants web administration. Keep it private; the session cookie is not a verified platform identity.
- Browser writes require the session’s CSRF value and a matching Origin. Scripts use `X-Agend-Token`; an Origin they supply must still match Host.
- `/view` reads are open on the loopback listener by default. Set `web.view_access: session` to require sign-in; profile writes always require authorization.

See the [web guide](web-dashboard.md) for devices, public links, uploads and previews, and [security](SECURITY.md#dashboard-sign-in-and-browser-sessions) for the complete credential rules.

### Applying settings changes

`POST /api/settings/apply` returns a job, and `GET /api/settings/apply/:jobId`
is the authority on it. Each affected agent is one row (`hot` for a change the
running agent takes over IPC, `restart` for one that needs the CLI restarted).

Send an `Idempotency-Key` you generate **before the first attempt** and reuse it
on every retry; a repeated key returns the original job instead of applying
everything twice. The old `POST /api/settings/reload` still works and still
sends SIGHUP, but it reports nothing about what happened.

The job is stored on disk, so a change that restarts AgEnD itself does not take
the answer down with it: the replacement process adopts the job, marks whatever
was still in flight as finished by the restart (`settled_by: "fleet-restart"`),
and keeps answering `GET`. Past the deadline the job reports `overdue` with a
"Still restarting (Ns)" message rather than spinning silently.

Only one reconcile runs at a time — two of them stop and start the same agent in
parallel — so SIGHUP and Apply share the slot: a signal arriving mid-apply is
coalesced into one replay, and a second Apply gets `409` with the running
`running_job_id`. The writes are already on disk by then, so retrying is safe.

A change that only a fresh AgEnD process can adopt ends as `restart-required`,
not `done`: it is saved, valid, and not in effect yet. That row keeps appearing
on every later apply until the process is actually restarted.

"Only a fresh process can adopt it" is a short list — the channel bindings,
`health_port`, `defaults.locale`, and the `cost_guard` / `webhooks` /
`daily_summary` / scheduler settings that are read once when their subsystem is
constructed. A changed `defaults.backend` is not on it: the agents absorb that
by restarting, and asking for a fleet restart on top would be theatre.

The panel can perform that restart (`POST /api/settings/restart-fleet`), behind
its own confirmation, its own idempotency key, and a rate limit of one restart
per 10 minutes and three per hour that is written to disk before anything is
launched — an in-memory counter would reset on the very restart it is limiting.
The restart is announced in your chat channel before it happens, and is refused
outright if it cannot be announced, so a panel restart is never invisible to the
people who would notice it was not them.

`apply_progress` SSE frames on `/ui/events` are an accelerator only. They carry
no event id, so a client that reconnects cannot ask for what it missed — treat a
frame as a signal to re-read the job.


**If a link loops back to “No session”**, check proxy HTTPS headers: a Secure cookie cannot be stored over plain HTTP.

## Schedules

```bash
agend schedule list             # List all schedules
agend schedule list --target <name> --json
agend schedule add              # Add a schedule from CLI
  --cron <expr>                 # Cron expression (required)
  --target <instance>           # Target instance (required)
  --message <text>              # Message to inject (required)
  --label <text>                # Human-readable label
  --timezone <tz>               # IANA timezone (default: Asia/Taipei)
agend schedule update <id>      # Update schedule parameters
  --cron --message --target --label --timezone --enabled <bool>
agend schedule delete <id>      # Delete a schedule
agend schedule enable <id>      # Enable a schedule
agend schedule disable <id>     # Disable a schedule
agend schedule history <id>     # Show schedule run history (--limit <n>)
```

## Template deployments

Template deployment is managed via MCP tools (used by agents), not CLI commands:

- `deploy_template` — deploy a template from `fleet.yaml` into a directory
- `teardown_deployment` — stop and delete all instances from a deployment
- `list_deployments` — list active deployments with status

See [configuration.md](configuration.md#templates) for template definition syntax.

## Topic bindings

```bash
agend topic list                # List topic bindings
agend topic bind <name> <tid>   # Bind instance to topic
agend topic unbind <name>       # Unbind instance from topic
```

## Access control

```bash
agend access list <name>        # List allowed users
agend access remove <name> <uid> # Remove user
agend access lock <name>        # Lock instance access (whitelist only)
agend access unlock <name>      # Unlock instance access (enable pairing)
agend access pair <name> <uid>  # Generate pairing code
```

`access pair` generates a code; it does not approve one. There is no CLI code-confirmation command or `access add`. An owner can grant access through the configured user list; saved and YAML lists are combined as described in [access configuration](configuration.md#channelaccess).

## Setup & installation

```bash
agend quickstart                # CLI guided first-run: backend, chat channel, projects, fleet service (recommended)
agend setup                     # Browser first-run page, before a fleet exists
agend init                      # Interactive advanced wizard (setup-wizard); for first-run use quickstart or setup
agend install                   # Install, enable, and start system service (launchd/systemd)
agend install --no-activate     # Only write/update the service file
agend uninstall                 # Remove system service
agend export [path]             # Export config for device migration
agend export --full [path]      # Export config + all instance data
agend import <file>             # Import config from export file
agend shortcuts                 # WSL: create or update the Windows desktop shortcuts
```

**Windows desktop shortcuts from WSL (#1853).** `agend shortcuts` makes (or refreshes) **AgEnD 儀表板** and **AgEnD 重新啟動** on the Windows desktop, for an install that predates them or that is only ever updated with `agend update`. It runs the Windows installer's own shortcut code in Windows PowerShell through WSL interop, for this Linux (`WSL_DISTRO_NAME`) and the user running it, and records them in `%LOCALAPPDATA%\AgEnD\install.json`, the same file the installer writes. Each shortcut's first line says which Linux and user it opens ("AgEnD（Linux：AgEnD，使用者：root）"). If install.json already names another Linux or user (for example the separate `AgEnD` Linux and your own Ubuntu), it says so and asks before switching; without a terminal to ask in, it changes nothing. Outside WSL it changes nothing. When interop is off (no `WSLInterop` binfmt entry, or no `powershell.exe`), it says so and points to the other way: paste the Windows one-liner again, which on a PC that already has AgEnD only offers the shortcuts. After `agend update` in a WSL terminal without the shortcuts, one line suggests `agend shortcuts`, once (not in a chat `/update`, which has no terminal). An update never creates desktop items itself.

`agend quickstart` detects a Discord admin from a new message in the selected server or a DM to the bot, then asks you to confirm the displayed username and ID. Follow the send-message prompt after it connects. After at most 30 seconds, or if you decline, it requires a manual user ID (17–20 digits, no leading zero) and re-asks invalid input. Settings → Setup wizard and New connection also require a valid admin ID; Discord detection in the web form is not included yet. Telegram keeps its message detection, with a required positive user ID for manual web setup. Existing access lists are not migrated.

On Linux the systemd unit uses `KillMode=mixed`, so stopping or updating the service stops the fleet first and lets it quit each CLI in turn (#908). `agend restart`, which `agend update` runs, adds the line to an older unit and reloads systemd. If it cannot, the restart is refused with instructions. A `KillMode` you set yourself is left alone.

**Fleet stop grace (#1071).** Detached `agend restart` and AgEnD's systemd unit allow five minutes for shutdown. Busy Kiro instances drain, quit and escalate in bounded per-instance phases, but those waits add up across sequential batches; the old 10-second detached cutoff and 60-second unit could interrupt them. Restart migrates the shipped `TimeoutStopSec=60` default to `300` and checks systemd's loaded grace before stopping. Explicit custom values, duplicate assignments and drop-in overrides are preserved and warned about. Direct service-manager stop/restart still follows those operator settings and a shorter custom timeout can interrupt shutdown. `agend restart` refuses every selected systemd target whose loaded stop grace is unreadable or less than 300 seconds, including custom values and drop-ins. Five minutes is an outer limit, not a guarantee for arbitrary fleet size or slow/stuck transports.

Detached restart polls asynchronously with a monotonic deadline. If grace expires it rechecks the PID's start identity and command before SIGKILL, then waits up to five seconds for confirmed exit. Unreadable ownership or an owner that remains alive refuses the replacement instead of spawning a duplicate. If only the command becomes empty on the captured start identity, restart can wait for fresh exit evidence within the grace; that empty command never authorizes SIGKILL or replacement. launchd's existing stop/activation policy is unchanged.

The same migration also adds the #1113 settings to an older unit. `CoredumpFilter=0` keeps a crash dump to a few KB: on WSL every crash is piped to the WSL crash collector, which ignores `LimitCORE`, and kiro-cli and the fleet itself had left dumps of about 1 GB and 450 MB. `LimitCORE=0` covers systems that write core files directly. `TimeoutStartSec=15min` replaces the old unlimited start timeout, and `StartLimitIntervalSec=30min` with `StartLimitBurst=4` stops systemd from restarting a fleet that failed four times in 30 minutes. `agend restart` runs `systemctl reset-failed` first, so it is never blocked by that limit; a plain `systemctl --user restart` is. Some systemd versions (249 among them) ignore `CoredumpFilter=` in a unit file, so on Linux AgEnD sets `coredump_filter` to 0 itself: the fleet process at startup, and each CLI it launches (the launch command sets it in the pane's own shell first, so it applies even in a tmux server the fleet did not start). `AGEND_KEEP_COREDUMP_FILTER=1` turns both off: processes then keep the mask they inherit (from systemd, tmux or your shell), which is not necessarily a full dump. The unit file is left as it is either way; whatever it says, the runtime mask is what AgEnD sets unless you opt out.

**One out-of-memory kill no longer stops the whole fleet (#2015).** Everything an instance runs (its CLI, tmux, every command an agent starts) lives in the service's cgroup. With systemd's default `OOMPolicy=stop`, the kernel OOM-killing any one of those processes stopped the whole unit, every instance included. The unit now sets `OOMPolicy=continue`, so only the killed process dies:
- **A killed tool command** (a script an agent ran) is just an error the agent's CLI sees.
- **A killed CLI** is a crash the fleet restarts as usual.
- **A killed fleet process** is a failed service, and `Restart=on-failure` brings it back.

An update rewrites the user unit with the line. `agend restart` adds it to an older unit, and the update's refresh adds it to a legacy system unit (`/etc/systemd/system/agend.service`). A unit that sets its own `OOMPolicy` keeps it. systemd older than 243 does not know the key and ignores it, with a warning in the journal. macOS has no equivalent: launchd has no per-service cgroup, the kernel (jetsam) kills only the one process, and `KeepAlive` restarts the fleet if it is the one killed.

**The fleet's ready signal must reach systemd (#2331).** The unit is `Type=notify`: the fleet tells systemd it is ready (`READY=1`) through a short-lived `systemd-notify` helper, never as the main process, so systemd accepts it only with `NotifyAccess=all`. With `main`, `exec` or no `NotifyAccess` at all (systemd's default for `Type=notify` is `main`), it refuses the signal: `Got notification message from PID …, but reception only permitted for main PID …`. The fleet itself runs normally, but the unit stays `activating` until `TimeoutStartSec` runs out, and then systemd kills and restarts it — every 15 minutes since `TimeoutStartSec=15min` (#1113). When the timeout was `0`, the same unit sat in `activating` without anyone noticing.
- **The unit file:** `agend restart` and an update's refresh put `NotifyAccess=all` into a `Type=notify` unit (the user unit and a legacy system unit), replacing `main`, `exec` or `none`. AgEnD itself shipped `main` only in 0.0.24-beta.5 to beta.12.
- **A drop-in:** after the reload, AgEnD asks systemd what it has *loaded*. If a drop-in (AgEnD writes none but this one of its own) still sets another value, AgEnD adds its own last-sorting drop-in, `<unit>.d/zz-agend-notify.conf` with `NotifyAccess=all`, reloads and asks again. Your drop-in is left as it is and named; once it no longer sets `NotifyAccess`, AgEnD's file can go. If a drop-in that sorts later still wins, the restart goes ahead, with a line naming the file to fix.
- **Leftovers:** install, start, restart and an update name the files that can change how the fleet starts: a drop-in that sets `Type`, `NotifyAccess`, `ExecStart`, `TimeoutStartSec`, `WatchdogSec`, `Restart` or `EnvironmentFile`; a user unit beside the system unit that runs the fleet; units or plists under AgEnD's old labels (`com.ccd.fleet`, `com.claude-channel-daemon`, from source builds before the rename). They are named every time, until you remove them; AgEnD never removes them. The update's refresh no longer writes a user unit on a host whose fleet runs under the system unit, so one left from before is named once and does not come back.
- **`agend doctor`** shows the unit as systemd loaded it (the system unit when one runs the fleet) (`Type`, `NotifyAccess`, `TimeoutStartSec`), the files it came from (the unit file and each drop-in), and each leftover. A `Type=notify` unit without `NotifyAccess=all` is an error there.
- **The first update does it:** `agend update` runs the new release's own refresh and restart, so updating to a release with this fix repairs the unit in the same update.

**Which Node the service runs, and when `agend restart` refuses (#1450).**
- With AgEnD's bundled Node (or a validated `AGEND_NODE`), the unit (`ExecStart=`) and the plist (`ProgramArguments`)
  name that Node first, then the package's `dist/cli.js`, then `fleet start`. The bundled Node's path changes only when
  npm updates AgEnD, and `agend update` rewrites the service then. The runtime's directory is on no service PATH, so the
  coding CLIs keep the Node they had.
- Where AgEnD has no bundled Node (any platform other than glibc Linux and macOS 11+ on x64/arm64), the service starts
  the package's launcher (`<package>/launcher/agend fleet start`) instead. The launcher finds Node on the service's
  PATH at each start, so upgrading Node with nvm or Homebrew, which removes the old version's directory, does not break
  the service. A Node that is too old is refused at start, and the reason goes to the service log.
- Before stopping anything, `agend restart` checks that the definition the service manager has **loaded** starts
  exactly that: the selected Node named, this install's entry, `fleet start`, no `NODE_OPTIONS`/`NODE_PATH`, and no
  reload pending. Otherwise it refuses and stops nothing.
  - An older definition that leaves Node to `#!/usr/bin/env node` and the service's PATH is refused this way. Run
    `agend install` to rewrite it.
  - `agend restart --force` is for operators who have checked the service themselves. `agend update` never uses it.
  - With a system-source runtime, a changed nvm/Homebrew installation can leave the service's PATH selecting the old
    Node or no Node. Restart still refuses. In the shell selecting the intended Node, run `agend install --no-activate`,
    `systemctl --user daemon-reload`, then `agend restart` for a user unit. For a system unit, its owner must update
    `Environment=PATH` and run `systemctl daemon-reload` first; `agend install` writes only a user service. On macOS,
    `agend install --no-activate` followed by `agend restart` uses the planned launchd activation.
- **macOS:** `agend install` writes `~/Library/LaunchAgents/com.agend.fleet.plist` and loads it into `gui/<uid>`.
  That is the domain of your login session, where LaunchAgents are loaded at login.
  - For launchd, loading a plist is starting the job. So `agend install --no-activate` only writes and proves the new
    plist and records a planned activation; the job already loaded keeps running.
  - The next `agend restart` performs that activation once: one `bootout`, one `bootstrap`. Then `launchctl print`
    must show the new job running. If it does not, the previous plist is bootstrapped again and checked.
  - A Mac reached only over SSH, with nobody logged in, has no `gui/<uid>` domain (`launchctl` reports error 125).
    There a job can only be loaded into `user/<uid>`, with `LimitLoadToSessionType=Background`. `agend install` does
    not write that; such a job is yours to manage.

**How an update installs (#2264).** `agend update` and the install one-liner both run the target release's own
installer: `npm exec --yes --package @songsid/agend@<version> -- agend-install`. Re-running the one-liner is how to
repair any interrupted update. The installer:
- first takes its install lock, before it touches anything. If another installer is running, it stops and changes
  nothing (including that update's chat message); the one-liner then says that the install lock could not be taken
  (the installer prints why: to let a running install finish, or what to do about something left behind), and exits 75
  rather than reporting a failed install (#2284). A lock left by an installer that has exited is moved aside, and so is
  one that cannot be read once no process has it open (an older updater still writing it keeps it). Older AgEnD updaters see the installer's lock and
  wait for it. It keeps the lock until it is done;
- puts back npm's moved-aside copy of AgEnD (`@songsid/.agend-…`) when it is the only whole copy, so `agend` runs again.
  It does this only when no npm is installing, removing or updating packages on the host; otherwise it leaves npm's
  leftovers alone and says so. Nothing is deleted: what it moves aside goes to `<npm prefix>/.agend-quarantine/`;
- installs the release and checks that `agend --version` reports it. If npm fails but the previous version still runs,
  nothing else is done and the answer says so. If no working `agend` is left, the previous version is reinstalled;
- refreshes the service with the new release's `agend install --no-activate`, under the service manager it already
  has (a system-wide `/etc/systemd/system/agend.service` stays one). Then it restarts the fleet if it is running, or
  starts it if the service is installed but stopped. A fleet started by hand gets no service, and only an update
  restarts it. On Linux, `agend install`, `start` and `restart` turn on systemd linger for the user and find the user
  manager from any shell (root on WSL included). `status` and `stop` only fill in `XDG_RUNTIME_DIR` and the bus
  address; they change no host setting.

`agend update` runs a release's installer only when that release has one. For an older release (for example
`agend update --version` back to a release from before this change), and when the npm prefix needs sudo, it keeps the
older update path described below. There, a system-wide copy is retired after a move to nvm only if that copy is a 2.1
release.

**Update activation outcomes (#1490).** A verified package is not a running fleet. A confirmed restart succeeds;
an unfinished restart returns exit 75 (pending), keeps the update marker and all repair copies, and does not restore
or remove packages. A failed restart returns exit 1. For systemd, the updater can restore its package and unit preimages
only after checking the same loaded target, unchanged unit bytes, no pending job, and zero main/control PIDs, then
confirming a stop. It reloads and checks the old definition before starting a previously running service; a previously
stopped service stays stopped. Even successful recovery reports that the update failed. Changed or unreadable ownership,
missing preimages, detached owners, custom untracked stop modes and incomplete recovery require operator inspection; they never count as rollback
success. Inspect the selected unit with `systemctl [--user] status <unit>` before retrying. These checks do not make
external service/package edits atomic; keep other installers and service operators out of an update's transition.
Recovery restores the previous executable's policies, without reverting the data directory. Review the
[downgrade compatibility limits](downgrade-compatibility.md) when the preimage is from an older release.

Chat `/update` uses the verified installed executable. On Linux, when the fleet
is inside a service cgroup, it starts the updater in an independent user scope
before the existing two-second delay. `detached` alone does not survive a
systemd service stop. The scope inherits the fleet's environment and working
directory; credentials are not put in command arguments. This requires a
reachable same-user systemd manager and `systemd-run` 240 or newer. A fleet under
the system manager (the legacy `/etc/systemd/system/agend.service`, run as root)
gets a scope from the system manager instead, which only root can ask for; a
system service's fleet that is not root refuses the chat update (#2274). An unknown
cgroup, unsupported helper or launch failure refuses the chat update and asks
you to run `agend update` from a host shell; it never falls back into the fleet's
cgroup. Detached Linux fleets outside service cgroups and macOS keep the
existing launch path. The scope isolates the updater from the fleet stop, not
from host shutdown or logout that stops the user manager.

## Environment variables

| Variable | Description |
|----------|-------------|
| `AGEND_BOT_TOKEN` | Telegram/Discord bot token (or use `bot_token_env` in fleet.yaml to customize the env var name) |
| `GROQ_API_KEY` | Groq API key for voice transcription (optional) |
| `AGEND_TMUX_SESSION` | Override tmux session name (default: `agend`) |
| `AGEND_HOME` | Override data directory (default: `~/.agend`) |

## `agend settings`

```bash
agend settings confirm <id>        # Print source/requester/full redacted diff, then ask y/N
agend settings confirm <id> --yes  # Explicitly confirm that inspected diff without a TTY
agend settings reject <id>         # Reject a pending Settings change on this host
```

Run on the host as the same user as the fleet or SetupHost. This never starts a fleet; a private local socket owns confirmation. Agent sessions (`AGEND_INSTANCE_NAME` present) cannot use it. The id, socket owner generation and inspected effect/summary are checked again before applying. A stale/expired request must be submitted again; pending requests are not persisted across restart.

## Redacted bug reports

General/coordinators have the managed `bug-report` skill. It collects a report locally, attaches the redacted Markdown file in chat, and asks you to approve the exact issue title, body and file before generating a GitHub link. You can also use the CLI:

```bash
agend bug-report --since 30m --out report.json --description-file problem.txt --steps-file steps.txt
# Inspect report.json and report.json.md. Approval is the SHA256 printed by collection:
agend bug-report --draft report.json --approve <SHA256>
```

The second command prints a prefilled GitHub new-issue link; it does not open a browser or submit an issue. You submit with your own GitHub account. Without GitHub, keep/share `report.json.md` yourself. There is no community channel, project webhook, bundled token or automatic upload.

The default window is the last 30 minutes; `--since` accepts positive `m`, `h`, `d` durations up to 7 days. Each `daemon.log`/`fleet.log` read is limited to a 256 KiB tail and 1,500 lines, plus an optional bounded 5-second systemd user-unit journal query. Timestamps in the requested window are selected; untimestamped stderr diagnostics are labelled time-unknown, not claimed to fall within that window. Rotated logs are not collected. The report states omissions/unavailable sources. Environment includes the installed AgEnD version, Node/runtime, OS and WSL/distro. Backend versions use existing unprofiled `cli-env` cache version/date fields and structured log evidence, without launching CLIs; unknown or stale evidence is labelled. No transcripts, credential configuration, environment dump or model catalog is exported.

One shared redactor covers credential formats/fields/headers/cookies and personal identifiers. Chat/topic/user identifiers and free-form log prose are withheld; recognized error codes, crash phrases and sanitized stack locations are retained. This deliberately removes some useful detail. `--keep-identifiers` explicitly retains email, IP/hostname and path username information; it never disables secret or chat-identifier redaction. Inspect the draft: arbitrary unrecognized secrets in a supplied description cannot be guaranteed safe by pattern matching.

Both files are new, mode 0600; existing files/symlinks are not overwritten. The JSON review snapshot binds the exact title, issue body, full Markdown and delivery mode. An edit requires fresh approval. Links are capped at 7,500 encoded characters. Larger reports keep their complete redacted Markdown locally; the approved link body explicitly asks you to add that file manually rather than silently dropping evidence. Review the file you actually attach.

Optional existing host GitHub CLI login: choose `--submit` during collection, review that delivery mode and exact text, then repeat `--submit` with `--draft`/`--approve`. Authentication is checked only after approval. AgEnD never logs in or stores a token. Overflow needs manual attachment and uses link mode. If creation times out or has an uncertain result, check GitHub before trying again.
