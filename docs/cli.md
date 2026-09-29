# CLI Reference

## Telegram commands (General topic)

| Command | Description |
|---------|-------------|
| `/status` | Fleet table with Backend, Model, Ctx, Effort, Cost and State columns (admin only) |
| `/restart` | In-process restart all instances (no process exit) |
| `/update` | Update AgEnD to the latest version (admin only) |
| `/sysinfo` | Show detailed system diagnostics (version, load, IPC status, each backend CLI's version) |
| `/pause` | Manually pause an instance (admin only) |
| `/wake` | Wake a paused instance (admin only) |

All other operations (create/delete/start instances, delegate tasks) are handled by the General instance through natural language.

## Service management

```bash
agend start                     # Start AgEnD service (requires install)
agend stop                      # Stop AgEnD service
agend restart                   # Restart AgEnD service
agend update                    # Update on the installed channel (a beta stays on beta) and restart
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
agend backend trust <backend>   # Pre-trust working directories (avoid CLI trust dialogs)
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
- **`/dashboard revoke`** in the chat signs every browser out and withdraws any
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
agend schedule trigger <id>     # Manually trigger a schedule
```

## Template deployments

Template deployment is managed via MCP tools (used by agents), not CLI commands:

- `deploy_template` — deploy a template from `fleet.yaml` into a directory
- `teardown_deployment` — stop and delete all instances from a deployment
- `list_deployments` — list active deployments with status

See [configuration.md](configuration.md#templatesname) for template definition syntax.

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

The same migration also adds the #1113 settings to an older unit. `CoredumpFilter=0` keeps a crash dump to a few KB: on WSL every crash is piped to the WSL crash collector, which ignores `LimitCORE`, and kiro-cli and the fleet itself had left dumps of about 1 GB and 450 MB. `LimitCORE=0` covers systems that write core files directly. `TimeoutStartSec=15min` replaces the old unlimited start timeout, and `StartLimitIntervalSec=30min` with `StartLimitBurst=4` stops systemd from restarting a fleet that failed four times in 30 minutes. `agend restart` runs `systemctl reset-failed` first, so it is never blocked by that limit; a plain `systemctl --user restart` is. Some systemd versions (249 among them) ignore `CoredumpFilter=` in a unit file, so on Linux AgEnD sets `coredump_filter` to 0 itself: the fleet process at startup, and each CLI it launches (the launch command sets it in the pane's own shell first, so it applies even in a tmux server the fleet did not start). `AGEND_KEEP_COREDUMP_FILTER=1` turns both off: processes then keep the mask they inherit (from systemd, tmux or your shell), which is not necessarily a full dump. The unit file is left as it is either way; whatever it says, the runtime mask is what AgEnD sets unless you opt out.

## Environment variables

| Variable | Description |
|----------|-------------|
| `AGEND_BOT_TOKEN` | Telegram/Discord bot token (or use `bot_token_env` in fleet.yaml to customize the env var name) |
| `GROQ_API_KEY` | Groq API key for voice transcription (optional) |
| `AGEND_TMUX_SESSION` | Override tmux session name (default: `agend`) |
| `AGEND_HOME` | Override data directory (default: `~/.agend`) |
