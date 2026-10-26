# AgEnD in Docker: a runbook for agents

This document is for an AI agent that sets up AgEnD in Docker for a person and keeps it running. Follow the steps in
order. Run every command yourself and check its result before going on. Tell the person what you did and what you need
from them. Nothing here needs changes to AgEnD itself: the image installs the published npm package.

The result is one container running a whole AgEnD fleet, supervised by Docker. It has:
- a non-root user (uid 1000) and tini as PID 1;
- AgEnD's data and every AI CLI's install and login in a named volume;
- the dashboard on the host's `127.0.0.1:19280`.

On a server the person keeps, a regular install (`install.sh`, a systemd or launchd service) is still the recommended
path. Docker suits trials, demos, and machines where they would rather not install Node.js and tmux.

## Rules for the agent

- **Never run `agend update`, `agend restart`, `agend stop` or `agend install` inside the container, and never use
  `/update` in the fleet's chat.** The container has no systemd. An update replaces the AgEnD inside the container, but
  not the image it was built from, so the next container start rolls it back. `restart`, `stop` and `install` expect a
  service manager the container does not have. Use the `docker compose` commands in [Maintain](#maintain) instead.
- Keep tokens and API keys only in `.env`, never in `fleet.yaml`, `compose.yaml` or a chat.
- Keep the published port on `127.0.0.1` unless the person asks for another address on purpose. Then also add the host
  name to `web.allowed_hosts` in `fleet.yaml`.

## 1. Ask the person

| Question | Why it matters |
|---|---|
| Which AI backends? (`claude-code`, `codex`, `kiro-cli`, `grok`, `opencode`, `antigravity`, `muse`) | Step 4 installs only these |
| Pin any CLI version? | `claude-code` and `kiro-cli` installers take a version; the others install the newest |
| Web only, or also a Telegram or Discord channel? | Step 5's `fleet.yaml`; a channel needs a bot token, the group or guild id, and their user id |
| Host OS: Linux, or Docker Desktop on macOS or Windows (WSL)? | WSL has a bind-mount trap (see [Troubleshooting](#troubleshooting)) |
| CPU architecture (`uname -m`: `x86_64` or `aarch64`)? | kiro-cli's pinned tarball is per architecture |
| AgEnD version: `latest` (stable), `beta`, or an exact one? | `AGEND_VERSION` in step 2 |

Check that Docker works: `docker compose version` must print v2.24 or newer.

## 2. Write the files

Make a folder (for example `~/agend-docker`) and write these four files into it exactly.

<!-- file: Dockerfile -->
```dockerfile
# AgEnD + tmux on Node 22. No AI CLI is baked in: they are installed into the home volume (step 4).
FROM node:22-bookworm-slim
ARG AGEND_VERSION=latest
RUN apt-get update \
 && apt-get install -y --no-install-recommends tmux git curl ca-certificates procps xz-utils unzip less tini socat bash \
 && rm -rf /var/lib/apt/lists/*
RUN npm install -g "@songsid/agend@${AGEND_VERSION}" && npm cache clean --force
# The base image's uid-1000 user, renamed: a bind mount owned by a typical host user matches it.
RUN groupmod -n agend node \
 && usermod -l agend -d /home/agend -m -c AgEnD node \
 && mkdir -p /work && chown agend:agend /work
COPY --chmod=755 entrypoint.sh /usr/local/bin/agend-entrypoint
# The CLIs' own self-updates stay off, so a pinned version stays and updates go through this runbook.
ENV HOME=/home/agend \
    PATH=/home/agend/.local/bin:/home/agend/.opencode/bin:/home/agend/.grok/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    DISABLE_AUTOUPDATER=1 KIRO_NO_AUTO_UPDATE=1 OPENCODE_DISABLE_AUTOUPDATE=1 \
    TERM=xterm-256color LANG=C.UTF-8
USER agend
WORKDIR /home/agend
VOLUME ["/home/agend", "/work"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=5m --retries=3 CMD curl -fsS http://127.0.0.1:19280/health >/dev/null || exit 1
# tini as PID 1 reaps the CLIs' children: without it, a killed CLI stays a zombie that still holds its session lock.
ENTRYPOINT ["tini", "--", "agend-entrypoint"]
```

<!-- file: entrypoint.sh -->
```sh
#!/bin/sh
# With arguments: run them (installs, one-off commands). Without: run the fleet in the foreground.
set -eu
if [ "$#" -gt 0 ]; then exec "$@"; fi
if [ ! -f "$HOME/.agend/fleet.yaml" ]; then
  echo "agend-entrypoint: no ~/.agend/fleet.yaml yet (runbook step 5)" >&2
  sleep 30; exit 78
fi
# AgEnD's dashboard listens on 127.0.0.1 inside the container, which a published port cannot reach.
# socat forwards the container's port 19380 to it.
socat TCP-LISTEN:19380,fork,reuseaddr,bind=0.0.0.0 TCP:127.0.0.1:19280 &
exec agend fleet start
```

<!-- file: compose.yaml -->
```yaml
name: agend
services:
  agend:
    build:
      context: .
      args:
        AGEND_VERSION: ${AGEND_VERSION:-latest}
    image: agend-local:${AGEND_VERSION:-latest}
    restart: unless-stopped
    # The fleet stops its instances gracefully before it exits.
    stop_grace_period: 2m
    env_file:
      - path: .env
        required: false
    ports:
      - "127.0.0.1:${AGEND_PORT:-19280}:19380"
    volumes:
      - agend-home:/home/agend
      - agend-work:/work
volumes:
  agend-home:
  agend-work:
```

<!-- file: .env -->
```sh
# AgEnD version for the image: latest, beta, or an exact version (2.3.1).
AGEND_VERSION=latest
# Host port of the dashboard.
AGEND_PORT=19280
# Chat platform tokens, only if the person wants a channel (step 5):
# TELEGRAM_BOT_TOKEN=
# DISCORD_BOT_TOKEN=
# API keys, if a CLI signs in with a key instead of a login (step 7):
# ANTHROPIC_API_KEY=
# OPENAI_API_KEY=
# XAI_API_KEY=
```

Then build the image. The build output ends with `naming to … agend-local:<version>`.

```sh
docker compose build
```

## 3. Check the image

```sh
docker compose run --rm agend sh -c 'id; agend --version; tmux -V'
```

Expect `uid=1000(agend)`, an AgEnD version, and a tmux version.

## 4. Install the AI CLIs

Run one line per backend the person chose. Each line installs into the home volume, so later restarts and image updates
keep it. Replace `<version>` with a pin, or use the unpinned form.

| Backend | Install (unpinned) | Pinned |
|---|---|---|
| claude-code | `curl -fsSL https://claude.ai/install.sh \| bash` | `curl -fsSL https://claude.ai/install.sh \| bash -s <version>` |
| kiro-cli | `curl -fsSL https://cli.kiro.dev/install \| bash` | see below |
| codex | `curl -fsSL https://chatgpt.com/codex/install.sh \| CODEX_NON_INTERACTIVE=1 sh` | ❌ |
| grok | `curl -fsSL https://x.ai/cli/install.sh \| bash` | ❌ |
| opencode | `curl -fsSL https://opencode.ai/install \| bash` | ❌ |
| antigravity | `curl -fsSL https://antigravity.google/cli/install.sh \| bash` | ❌ |
| muse | `mkdir -p ~/.local/bin && curl -fsSL https://api.meta.ai/muse-launcher.sh -o ~/.local/bin/muse && chmod +x ~/.local/bin/muse && MUSE_LAUNCHER_INSTALL=1 ~/.local/bin/muse` | ❌ |

Run each one inside the image:

```sh
docker compose run --rm agend sh -c 'curl -fsSL https://claude.ai/install.sh | bash'
```

For a pinned kiro-cli, set `V` to the version and `ARCH` to `x86_64` or `aarch64`:

```sh
docker compose run --rm agend sh -c 'set -e; V=2.34.0; ARCH=x86_64; D="$HOME/.local/share/agend-cli/kiro-cli/$V"
  mkdir -p "$D" "$HOME/.local/bin"
  curl -fsSL "https://prod.download.cli.kiro.dev/stable/$V/kirocli-$ARCH-linux.tar.xz" | tar -xJ -C "$D"
  for b in "$D"/kirocli/bin/*; do ln -sf "$b" "$HOME/.local/bin/$(basename "$b")"; done'
```

Check each CLI. A pinned one must print the pinned version:

```sh
docker compose run --rm agend sh -c 'claude --version; kiro-cli --version'
```

Installers download from the vendors' sites, so this step needs network access. If one fails, its output says why. Fix
it, or leave that backend out of `fleet.yaml`.

## 5. Write the first `fleet.yaml`

Write it next to the other files, then copy it into the volume as the container's user. That user is the owner AgEnD
requires.

<!-- file: fleet.yaml -->
```yaml
# One instance per backend the person chose. working_directory is in the work volume.
instances:
  dev:
    backend: claude-code
    working_directory: /work/dev
```

- **A kiro-cli instance:** also set `kiro_ui: tui`.
- **Several instances:** one block each, with distinct names.
- **A Telegram or Discord channel:** add the block below. The token goes in `.env` as `TELEGRAM_BOT_TOKEN` or
  `DISCORD_BOT_TOKEN`. `allowed_users` holds the person's numeric user id. AgEnD creates the General instance on the
  first start.

```yaml
channels:
  - type: telegram            # or discord
    mode: topic
    bot_token_env: TELEGRAM_BOT_TOKEN
    group_id: "-1001234567890"  # the Telegram forum group, or the Discord guild id
    access:
      mode: locked
      allowed_users: ["123456789"]
```

```sh
docker compose run --rm -T agend sh -c 'mkdir -p ~/.agend && chmod 700 ~/.agend && cat > ~/.agend/fleet.yaml' < fleet.yaml
docker compose run --rm agend agend validate
```

`agend validate` must report no errors. On a web-only fleet it warns that no channel and no General are configured:
that is expected.

## 6. Start and verify

```sh
docker compose up -d
```

Wait until it is healthy (the first start can take a minute):

```sh
until curl -fsS http://127.0.0.1:19280/health >/dev/null; do sleep 3; done; docker compose ps
```

Check the fleet and its instances:

```sh
docker compose exec agend tmux list-windows -t agend
docker compose logs --tail 50 agend
```

Each instance has a tmux window. Then give the person a sign-in code for the dashboard:

```sh
docker compose exec agend agend web --code
```

It prints a one-time code (valid about 5 minutes) and `http://localhost:19280/signin`. If `AGEND_PORT` is not 19280,
replace the port in that URL. The person opens it, enters the code, and sends a message to an instance in the web chat.
A reply confirms the whole path. If the CLI is not signed in yet, the instance says so: do step 7 first.

## 7. Sign the CLIs in

Use any one of these per backend:

| Backend | `/login` (chat or dashboard) | API key in `.env` | Shell in the container |
|---|:-:|:-:|:-:|
| claude-code | ✅ | ✅ | ✅ |
| codex | ✅ | ✅ | ✅ |
| kiro-cli | ✅ | ❌ | ✅ |
| grok | ✅ | ✅ | ✅ |
| opencode | ❌ | ✅ | ✅ |
| antigravity | ❌ | ❌ | ✅ |
| muse | ❌ | ❌ | ✅ |

The API keys:
- claude-code: `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN`;
- codex: `OPENAI_API_KEY`;
- grok: `XAI_API_KEY`;
- opencode: its providers' own keys.

- **`/login`:** in General, or the dashboard's sign-in for a backend. Browser and device-code flows work as on any
  install.
- **An API key:** add it to `.env`, then run `docker compose up -d` (it re-reads `.env`).
- **A shell:** `docker compose exec -it agend claude` (or `codex`, `kiro-cli`, `grok`, …). The person follows that CLI's
  own login.

Logins are kept in the home volume.

## Maintain

### Update AgEnD

1. Set the new version in `.env` (`AGEND_VERSION=2.3.2`), or keep `latest` to get the newest stable.
2. Rebuild and recreate:

```sh
docker compose build --pull --no-cache
docker compose up -d
docker compose exec agend agend --version
```

The volumes keep `fleet.yaml`, the databases, the CLIs and their logins. **Never** `agend update` or `/update` inside
the container: see the [rules](#rules-for-the-agent). The fleet's daily "new version available" notice says `/update`.
For this install, update with these steps instead.

### Restart, stop, start

| Do | Command |
|---|---|
| Restart the fleet | `docker compose restart` |
| Stop it | `docker compose stop` |
| Start it again | `docker compose up -d` |
| Remove the container (data kept) | `docker compose down` |

### Upgrade or pin a CLI

Run its install line from step 4 again, with the new version or unpinned, then `docker compose restart`. Check it with
`docker compose exec agend <cli> --version`.

### Add a backend or instance

Install its CLI (step 4), and add the instance to `fleet.yaml`. Copy the file in again as in step 5, run
`docker compose run --rm agend agend validate`, then `docker compose restart`.

To edit the live file, copy it out first:

```sh
docker compose exec -T agend cat .agend/fleet.yaml > fleet.yaml
```

### Logs

```sh
docker compose logs -f agend                          # the fleet's own output
docker compose exec agend tail -n 200 .agend/daemon.log   # the detailed log
docker compose exec agend ls .agend/instances/        # each instance's logs are in its folder
```

### Watch or type into an instance

```sh
docker compose exec -it agend tmux attach -t agend
```

Detach with `Ctrl-b d`. Don't type into an instance's window while it is working.

### Back up and restore

Back up while stopped. Each command runs in the image as root, with the volumes mounted where the service mounts them,
and writes into the current folder:

```sh
docker compose stop
docker compose run --rm --user root -v "$PWD":/b --entrypoint tar agend czf /b/agend-home.tgz -C /home/agend .
docker compose run --rm --user root -v "$PWD":/b --entrypoint tar agend czf /b/agend-work.tgz -C /work .
docker compose up -d
```

To restore, for example on a new machine with the same four files, build the image (step 2) and run:

```sh
docker compose run --rm --user root -v "$PWD":/b --entrypoint sh agend -c 'tar xzf /b/agend-home.tgz -C /home/agend && tar xzf /b/agend-work.tgz -C /work && chown -R 1000:1000 /home/agend /work'
docker compose up -d
```

## What works in Docker

| | Regular install | Docker (this runbook) |
|---|:-:|:-:|
| Web dashboard and web chat | ✅ | ✅ |
| Telegram / Discord | ✅ | ✅ |
| All seven backends install and run | ✅ | ✅ |
| `/login` for claude-code, codex, kiro-cli, grok | ✅ | ✅ |
| `agend update` / `/update` | ✅ | ❌ |
| `agend restart` / `stop` / `install` | ✅ | ❌ |
| A systemd / launchd service | ✅ | ❌ |
| `sudo` inside an instance's work | ✅ | ❌ |
| The dashboard from other machines by default | ❌ | ❌ |

Where Docker shows ❌, use the compose commands above. The container runs as a normal user and has no sudo.

## Troubleshooting

- **`agend-entrypoint: no ~/.agend/fleet.yaml yet`:** step 5 was skipped. Write the file, then `docker compose up -d`.
- **The dashboard does not load:**
  - Check `docker compose ps` (healthy?) and `docker compose logs agend`.
  - The URL's port must be `AGEND_PORT`.
  - The forwarder must be running: `docker compose exec agend pgrep -a socat`. A few `socat … Connection refused`
    lines in the log while the fleet starts are normal: the dashboard is not listening yet.
- **"requires an owned real AGEND_HOME" or permission errors on start:** the home volume, or a bind mount, is not owned
  by uid 1000. Fix it once:
  `docker compose run --rm --user root --entrypoint chown agend -R 1000:1000 /home/agend /work`.
- **On WSL, a bind-mounted folder comes back owned by root after Windows restarts.** Use the named volumes from
  `compose.yaml` instead of bind mounts.
- **A CLI is "not installed" after an image update:** only the volume keeps CLIs. Check that the compose project did
  not change: the volumes are named after `name:` in `compose.yaml` (`agend_agend-home`). Or run step 4 again.
- **An instance keeps asking to sign in:** do step 7. Device-code logins need the person to open the link in a browser.
- **Docker Desktop on WSL says `docker-credential-desktop.exe: exec format error` on a build:** start the build from
  Windows, or point `DOCKER_CONFIG` at a folder whose `config.json` is `{}`.
