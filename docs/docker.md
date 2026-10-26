# AgEnD with Docker

A second way to install AgEnD: `docker compose up` gives you a working fleet in a container. It suits trials, demos and
machines where you would rather not install Node.js and tmux. On a server you keep, the regular install (a systemd or
launchd service) stays the recommended path.

The image holds AgEnD, Node.js and tmux, but no AI CLI. On its first start it installs the CLIs your `fleet.yaml` uses
into its home volume, so later starts are instant.

> **Image publishing is not enabled yet.** Until `ghcr.io/songsid/agend` is published, build the image from a checkout
> of this repository with `docker/build-from-checkout.sh`, as below. It needs Node.js 22 on the build machine. A plain
> `docker compose build` installs the npm release, which may not have the container support yet.

## Quick start

```bash
git clone https://github.com/songsid/AgEnD.git && cd AgEnD/docker
cp .env.example .env          # optional: choose the instance, its backend, a chat platform
./build-from-checkout.sh      # until the image is published (then: skip this)
docker compose up -d          # first start installs the CLI(s); watch with: docker compose logs -f
docker compose exec agend agend web --code
```

Open `http://localhost:19280/` and enter the code. Your instance (`dev`, Claude Code by default) is in the sidebar. Sign
its CLI in (below) and talk to it in the chat.

## What happens on start

1. **First start only:** with no `~/.agend/fleet.yaml` yet, one is written from `.env`: one instance named
   `AGEND_INSTANCE` running `AGEND_BACKEND` in `/work/<name>`. It is web-only unless you configure a chat platform (below).
   It is never rewritten. To change it, copy it out, edit it, and write it back as the container's user:
   `docker compose exec -T agend cat .agend/fleet.yaml > fleet.yaml`, then
   `docker compose exec -T agend sh -c 'cat > .agend/fleet.yaml' < fleet.yaml` and `docker compose restart`.
2. **Every start:** every backend that `fleet.yaml` uses and that is not installed yet is installed with that backend's
   own installer, into the home volume. The log shows each CLI, and its version where it can be read without starting
   the CLI.
3. The fleet starts in the foreground. Docker's restart policy (`restart: unless-stopped`) keeps it running.

A CLI that fails to install is reported in the log; the fleet still starts, and that instance reports the missing CLI
as on any install.

## Signing in

**The dashboard:** `docker compose exec agend agend web --code` prints a one-time code for `http://localhost:19280/`.
With a chat platform, `/web` in General works too.

**The CLIs**, any of:
- `/login` in General, or the dashboard's sign-in for a backend: the browser or device-code flows work as on any install.
- A shell in the container: `docker compose exec -it agend claude` (or `codex`, `kiro-cli`, `grok`, …) and follow the
  CLI's own login.
- An API key in `.env`: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `XAI_API_KEY`, …

## A chat platform (optional)

In `.env`, before the first start:

```bash
AGEND_CHANNEL=telegram          # or discord
AGEND_GROUP_ID=-1001234567890   # the Telegram forum group, or the Discord guild id
AGEND_ADMIN_IDS=123456789       # your user id; only these people are let in
TELEGRAM_BOT_TOKEN=…            # or DISCORD_BOT_TOKEN
```

The token stays in `.env` (read on every start), never in `fleet.yaml`. To add a platform later, edit `fleet.yaml`
as described in [Configuration](configuration.md#channels).

## Settings (`.env`)

| Variable | Default | What it does |
|---|---|---|
| `AGEND_INSTANCE` | `dev` | First start: the instance's name |
| `AGEND_BACKEND` | `claude-code` | First start: its backend (`claude-code`, `codex`, `kiro-cli`, `grok`, `opencode`, `antigravity`, `muse`) |
| `AGEND_CLI_VERSIONS` | — | Pins, e.g. `claude-code=2.1.300,kiro-cli=2.34.0`. A pinned CLI at another version is installed again at the pin |
| `AGEND_CHANNEL`, `AGEND_GROUP_ID`, `AGEND_ADMIN_IDS` | — | First start: a Telegram or Discord channel |
| `AGEND_PORT` | `19280` | The host port of the dashboard |
| `AGEND_TAG` | `latest` | The image tag: `latest`, `beta`, or a version |

Only `claude-code` and `kiro-cli` installers take a version; for the others the newest is installed, and the log says
the pin was not applied. The CLIs' own self-updates are turned off in the image, so a pinned version stays.

## Where your data is

| Volume | Mounted at | Holds |
|---|---|---|
| `agend-home` | `/home/agend` | `~/.agend` (fleet.yaml, databases, instance state) and every CLI's install, login and settings |
| `agend-work` | `/work` | The instances' working directories |

Both are named volumes: `docker compose down` keeps them, `docker compose down -v` deletes them. Back up the home volume
with `docker run --rm -v agend_agend-home:/h -v "$PWD":/b alpine tar czf /b/agend-home.tgz -C /h .`.

Bind mounts are possible, but the directory must be owned by uid 1000 (the image's `agend` user). Prefer named volumes:
on WSL, a bind-mounted directory can come back owned by root after a restart. If the start fails with "must be owned
and writable by uid 1000", the log prints the one command that fixes it.

## Updating, restarting, stopping

| On a regular install | In the container |
|---|---|
| `agend update`, `/update` | `docker compose pull && docker compose up -d` (in the container, both refuse and say this). Until the image is published: `git pull`, `./build-from-checkout.sh`, `docker compose up -d` |
| `agend restart`, `/restart` | the same: the fleet exits and Docker starts it again |
| `agend stop` | `docker compose stop` (in the container, `agend stop` refuses: Docker would start it again) |
| `agend install` (a service) | not needed: Docker's restart policy supervises the fleet |
| `agend logs`, `fleet.log` | `docker compose logs -f`, plus the files in `~/.agend` |
| `tmux attach -t agend` | `docker compose exec -it agend tmux attach -t agend` |

The daily update check tells you about a new version with the `docker compose` line.

## What works in the container

| | Regular install | Container | Notes |
|---|:-:|:-:|---|
| Web dashboard and web chat | ✅ | ✅ | |
| Telegram / Discord | ✅ | ✅ | ¹ |
| Claude Code, Codex, kiro-cli, Grok, OpenCode, Antigravity, Muse installed by AgEnD | ✅ | ✅ | installed into the home volume on first start |
| CLI sign-in through `/login` or the dashboard | ✅ | ✅ | ¹ |
| Pinned CLI versions | ❌ | ✅ | `AGEND_CLI_VERSIONS`; claude-code and kiro-cli only |
| `agend update` / `/update` | ✅ | ❌ | update the image instead |
| A systemd / launchd service | ✅ | ❌ | Docker's restart policy supervises the fleet |
| `sudo` inside an instance's work | ✅ | ❌ | the container runs as a normal user |
| The dashboard reachable from other machines by default | ❌ | ❌ | both listen host-locally; a named tunnel, or a public link on a fleet with a chat platform, works on both ¹; or publish the container port on another address on purpose and add the name to `web.allowed_hosts` |

¹ The same code as a regular install. The container's end-to-end check covered the web chat; bot tokens, vendor
sign-ins and tunnels were not part of it (no real accounts).

## Troubleshooting

- **The dashboard does not load.** `docker compose ps` should show the container as healthy after the first start
  (installing a CLI can take a few minutes). Check the port: `AGEND_PORT` in `.env` must match the URL you open.
- **"must be owned and writable by uid 1000".** A bind mount or a volume created by root. Run the command the log prints,
  or use the named volumes from `compose.yaml`.
- **A CLI did not install.** The log line says why. The installers download from the vendors' sites, so the first start
  needs network access.
