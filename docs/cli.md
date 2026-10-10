# CLI Reference

## Chat commands (Telegram fleet menu / Discord slash)

The Telegram fleet menu (General topic and instance topics, `setMyCommands`) lists 19 commands; Discord registers 25 slash commands globally — the same 19 plus `/start`, `/stop`, `/chat`, `/save`, `/load` and `/cancel`. `/cancel` and `/save` are handled when typed on Telegram but intentionally kept out of its menu. 🔒 needs a fleet admin; the lock prefix in each menu is generated from `src/command-table.ts`, never typed. See [commands.md](commands.md) for the per-platform permission details.

| Command | Description | Options / args | Permission |
|---------|-------------|----------------|------------|
| `/status` | Fleet table with Backend, Model, Ctx, Effort, Cost and State columns | — | 🔒 admin |
| `/sysinfo` | Show detailed system diagnostics (version, load, IPC status, each backend CLI's version); also `/sys-info`, `/sys_info` on Telegram | — | All |
| `/dashboard` (or `/web`) | Sign in to the web dashboard and web chat: the sign-in link and a one-time code (spoilered on Telegram, visible only to you on Discord). On a `localhost` dashboard it also says how to reach it from a phone. `/dashboard revoke` (on Discord, the `action: revoke` option) signs every browser out | `[revoke]` | 🔒 admin |
| `/ctx` | Show agent context usage | — | All |
| `/compact` | Compact agent context | `[instructions]` — steers the summary, Claude Code only | All in fleet topics |
| `/steer` | Interject into the agent's current turn instead of queueing for idle | `<message>` required; `claude-code`/`codex`/`grok`/`muse`, and `kiro-cli` on its verified TUI ([details](commands.md#steer-btw-and-clear-backend-support)) | All |
| `/btw` | Side question without interrupting the current task | `<message>` required; `claude-code` only | All |
| `/clear` | Full conversation reset (destructive — asks Confirm/Cancel) | — | 🔒 admin |
| `/model` | Switch backend model | Name or inline keyboard/select menu | 🔒 admin |
| `/effort` | Adjust AI reasoning effort | `low\|medium\|high\|xhigh\|max`, or menu with no arg | 🔒 admin |
| `/pause` | Manually pause an idle instance | `[instance]` — required in General | 🔒 admin |
| `/wake` | Wake a paused instance | `[instance]` — required in General | 🔒 admin |
| `/restart` | Restart all instances in-process (no process exit) | `[full]` / `mode: full` reloads the entire fleet process and adapters | 🔒 admin |
| `/collab` | Toggle bot/webhook message reception | — | All in fleet topics (not a command in ClassicBot chats) |
| `/update` | Update AgEnD to the latest version on the installed channel | — | 🔒 admin |
| `/doctor` | Run fleet health diagnostics | — | 🔒 admin |
| `/login` | (beta) Remote CLI sign-in, installing the CLI first when missing | `[backend] [cancel]`; `/login cancel` anytime | 🔒 admin |
| `/usage` | Show AI subscription usage | — | All |
| `/tips` | Draw a random usage tip where you ran it | `[mode]` — `on\|off` toggles the daily auto-send, `advanced on` unlocks the advanced tier (both admin) | All for a draw |

All other operations (create/delete/start instances, delegate tasks) are handled by the General instance through natural language.

## Service management

```bash
agend start                     # Start AgEnD service (requires install)
agend stop                      # Stop AgEnD service
agend restart                   # Restart AgEnD service
agend update                    # Update on the installed channel (an alpha stays on alpha, a beta on beta) and restart
agend update --alpha            # Install from the alpha channel (previews of the next minor)
agend update --beta             # Install from the beta channel
agend update --stable           # Install from the stable channel, even from a beta (may go back a version)
agend update --version 2.1.9    # Install a specific version
agend update --force            # Force reinstall and restart even when already up to date
agend reload                    # Hot-reload config (sends SIGHUP to fleet process)
```

`agend reload` re-reads `fleet.yaml` and reconciles instances: new instances are started, removed instances are stopped, and changed configs are applied — without restarting the fleet process.

### Who stopped the fleet

`agend stop`, `agend restart`, `agend update`, `agend fleet stop` and `agend fleet restart` (without an instance name) affect every instance, so each one writes a line to `restart-audit.log` in the AgEnD home **before** it acts: the time, the command, the chain of parent processes with their command lines, the working directory, whether stdin was a terminal, and `AGEND_INSTANCE_NAME` when it ran inside a fleet agent's session. Instance-level `fleet stop <name>` / `fleet restart <name>` are recorded too. When the fleet receives the resulting signal it names that request in its own log, so an unexpected restart can be traced even though `fleet.log` is rewritten by the restart.

Started from a fleet agent's session (`AGEND_INSTANCE_NAME` is set, and is inherited by everything the agent runs — including a `$(...)` or backtick inside a quoted argument), those commands are refused unless you add `--yes`; the refusal is recorded as well. From a test runner (`VITEST` / `NODE_ENV=test`) they are refused outright; `AGEND_ALLOW_TEST_FLEET_CONTROL=1` lifts that for a test that really targets a scratch fleet. `/update` and `/restart` sent by a fleet admin are recorded with who sent them.

## Fleet management

```bash
agend fleet start               # Start all instances (manual mode)
agend fleet start <name>        # Start a specific instance
agend fleet stop                # Stop all instances
agend fleet stop <name>         # Stop a specific instance
agend fleet restart             # Graceful restart (wait for idle, same code)
agend fleet restart <name>      # Restart a specific instance
agend fleet restart --reload    # Full process restart to load new code
agend fleet status              # Show instance status overview
agend fleet status --json       # JSON output
agend fleet logs                # (alias — prints "Use agend logs instead")
agend fleet history             # Show event history (cost, rotations, hangs)
agend fleet history --instance <name> --type <type> --since <date> --limit <n> --json
agend fleet activity            # Show activity log (collaboration, tool calls, messages)
agend fleet activity --since 2h --limit 200 --format text
agend fleet activity --format mermaid  # Output activity as Mermaid sequence diagram
agend fleet cleanup             # Remove orphaned instance directories
agend fleet cleanup --dry-run   # Preview cleanup without deleting
```

## Instance tools

```bash
agend ls                        # List instances with status, backend, team, context, activity
agend ls --json                 # JSON output
agend ls --names-only           # Names one per line (used by shell completion)
agend attach [name]             # Attach to instance tmux window (fuzzy match, interactive menu)
agend logs                      # Show fleet log
agend logs -n 100               # Show last 100 lines (default: 50)
agend logs -f                   # Follow mode (tail -f)
agend logs --instance <name>    # Filter by instance name
agend export-chat               # Export fleet activity as HTML chat log
agend export-chat --from <date> --to <date> -o <path>
```

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
agend doctor                    # Run fleet health diagnostics
agend doctor mcp                # Fleet-wide MCP health check (IPC, config paths, duplicates, binary PATH)
agend health                    # Fleet health check — shows problems and diagnostics
agend validate                  # Validate fleet.yaml and classicBot.yaml
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

The dashboard signs in with a **one-time code**, not a link that carries a
credential. Send `/dashboard` to your bot (or run `agend web --code` on the host)
and you get the sign-in page address plus an 8-character code — `ABCD-EFGH`,
typed with or without the dash, in any case. Type it into the sign-in page and
you are signed in to `/ui`, `/view` and `/settings` for as long as the session
lasts, with nothing in the address bar, the browser history or any log that
records request URLs.

- **The code works once and expires after 5 minutes.** Only the newest code
  works: asking again replaces the previous one. Five wrong tries use up that one
  code (ask for another); enough wrong tries across codes pause sign-in for a few
  minutes. While no code has been issued there is nothing to guess.
- **A session is an opaque server-side record**, not a value derived from
  `web.token`. It ends after 12 hours from sign-in at the latest, or after 2
  hours without use, whichever comes first — the server decides, not the
  browser. It survives a fleet restart (Settings can restart the fleet).
- **`/dashboard revoke`** in the chat (on Discord, the `/dashboard` slash command with `action: revoke`) signs every browser out and withdraws any
  unused code. `agend web-token rotate` does the same and also rotates the token
  the CLI uses; a running fleet picks it up with no restart. The sign-in
  endpoints also list your signed-in devices and end one or all of them
  (`GET/DELETE /auth/sessions`).
- **Each sign-in is announced** in the General topic ("New web sign-in: Chrome on
  macOS"). If it was not you, send `/dashboard revoke`. Turn this off with
  `web.notify_login: false`.
- **Writes need more than the cookie.** The panels add a per-session
  `X-Agend-CSRF` header to every write, and the server also requires a matching
  `Origin`; a cookie alone cannot change anything.
- **One navigation across the panels.** `/ui`, `/view` and `/settings` share a
  *Dashboard · View · Settings* bar and a **Session** menu (which browser you are,
  when the session ends, your other signed-in devices with a Sign-out each, and
  Sign out everywhere). `/` opens the dashboard. If the dashboard's live stream is
  silent — a proxy that buffers it, or a path that cannot carry SSE such as a
  Cloudflare Quick Tunnel — it polls `/ui/poll` every 5 seconds until the stream
  speaks again.
- **`/view` reads are open by default** (it is a read-only dashboard on a loopback
  listener) — including the live terminal capture, so anyone who can reach the
  port can watch your agents. Set `web.view_access: session` in `fleet.yaml` to
  require a sign-in for the page, the capture, the roster and usage. **Editing a
  profile or avatar always needs a signed-in session** (or `X-Agend-Token` from a
  script): the Edit button on `/view` sends a signed-out visitor to sign in and
  back. The old "paste your web.token to save" box is gone, and `/view?token=…` no
  longer authorizes anything.
- **No credential ever goes into a URL.** A `/ui?token=…` link (as older versions
  printed, and as `agend web` used to open) is no longer a way in: it gets the
  sign-in page. `agend web` now prints a code and opens `/signin`; scripts keep
  using the `X-Agend-Token` header.

Following a link from Telegram or Discord into a panel lands on the sign-in page
first if the browser did not send the cookie on that cross-site hop
(`SameSite=Strict`); the page checks for a session from inside the site and
carries on to the panel you asked for by itself. (Verified on Chromium; Firefox
and WebKit have not been measured.)

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

**If following the link loops back to "No session" forever**, check what sits in
front of AgEnD. The cookie is marked `Secure` when the request arrives with
`X-Forwarded-Proto: https`, so a proxy that sets that header while actually
serving plain HTTP makes the browser refuse to store the cookie. It is a
misconfigured proxy, not a failed login.

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
agend schedule trigger <id>     # Prints how to trigger: the CLI cannot fire a schedule itself — use the Telegram interface with the fleet manager running
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

## Setup & installation

```bash
agend quickstart                # Simplified setup (recommended for new users)
agend init                      # Full interactive setup wizard
agend install                   # Install, enable, and start system service (launchd/systemd)
agend install --no-activate     # Only write/update the service file
agend uninstall                 # Remove system service
agend export [path]             # Export config for device migration
agend export --full [path]      # Export config + all instance data
agend import <file>             # Import config from export file
```

On Linux the systemd unit uses `KillMode=mixed`, so stopping or updating the service stops the fleet first and lets it quit each CLI in turn (#908). `agend restart`, which `agend update` runs, adds the line to an older unit and reloads systemd. If it cannot, the restart is refused with instructions. A `KillMode` you set yourself is left alone.

**Fleet stop grace (#1071).** Detached `agend restart` and AgEnD's systemd unit allow five minutes for shutdown. Busy Kiro instances drain, quit and escalate in bounded per-instance phases, but those waits add up across sequential batches; the old 10-second detached cutoff and 60-second unit could interrupt them. Restart migrates the shipped `TimeoutStopSec=60` default to `300` and checks systemd's loaded grace before stopping. Explicit custom values, duplicate assignments and drop-in overrides are preserved and warned about. Direct service-manager stop/restart still follows those operator settings and a shorter custom timeout can interrupt shutdown. `agend restart` refuses every selected systemd target whose loaded stop grace is unreadable or less than 300 seconds, including custom values and drop-ins. Five minutes is an outer limit, not a guarantee for arbitrary fleet size or slow/stuck transports.

Detached restart polls asynchronously with a monotonic deadline. If grace expires it rechecks the PID's start identity and command before SIGKILL, then waits up to five seconds for confirmed exit. Unreadable ownership or an owner that remains alive refuses the replacement instead of spawning a duplicate. If only the command becomes empty on the captured start identity, restart can wait for fresh exit evidence within the grace; that empty command never authorizes SIGKILL or replacement. launchd's existing stop/activation policy is unchanged.

The same migration also adds the #1113 settings to an older unit. `CoredumpFilter=0` keeps a crash dump to a few KB: on WSL every crash is piped to the WSL crash collector, which ignores `LimitCORE`, and kiro-cli and the fleet itself had left dumps of about 1 GB and 450 MB. `LimitCORE=0` covers systems that write core files directly. `TimeoutStartSec=15min` replaces the old unlimited start timeout, and `StartLimitIntervalSec=30min` with `StartLimitBurst=4` stops systemd from restarting a fleet that failed four times in 30 minutes. `agend restart` runs `systemctl reset-failed` first, so it is never blocked by that limit; a plain `systemctl --user restart` is. Some systemd versions (249 among them) ignore `CoredumpFilter=` in a unit file, so on Linux AgEnD sets `coredump_filter` to 0 itself: the fleet process at startup, and each CLI it launches (the launch command sets it in the pane's own shell first, so it applies even in a tmux server the fleet did not start). `AGEND_KEEP_COREDUMP_FILTER=1` turns both off: processes then keep the mask they inherit (from systemd, tmux or your shell), which is not necessarily a full dump. The unit file is left as it is either way; whatever it says, the runtime mask is what AgEnD sets unless you opt out.

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
reachable same-user systemd manager and `systemd-run` 240 or newer. An unknown
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
agend settings reject <id>
```

Run on the host as the same user as the fleet or SetupHost. This never starts a fleet; a private local socket owns confirmation. Agent sessions (`AGEND_INSTANCE_NAME` present) cannot use it. The id, socket owner generation and inspected effect/summary are checked again before applying. A stale/expired request must be submitted again; pending requests are not persisted across restart.
