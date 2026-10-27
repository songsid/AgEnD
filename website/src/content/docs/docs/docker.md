---
title: Docker
description: Run a whole AgEnD fleet in one Docker container, set up and maintained for you by an agent that follows the Docker runbook.
---

AgEnD can run as one container holding a whole fleet, supervised by Docker. You don't write the files yourself: [AgEnD in Docker](https://github.com/songsid/AgEnD/blob/main/docs/docker.md) is a runbook written for an agent. Give it to General, or to any agent, and it asks you a few questions, sets up the container, and maintains it afterwards. General agents have a `docker-install` skill that points to it.

On a server you keep, the regular install ([Getting Started](/AgEnD/docs/getting-started/)) with a systemd or launchd service is still the recommended path. Docker suits trials, demos, and machines where you'd rather not install Node.js and tmux.

## What you get

- A non-root user (uid 1000), with tini as PID 1.
- AgEnD's data and every AI CLI's install and login in a named volume, so a rebuild keeps them.
- The dashboard on the host's `127.0.0.1:19280` only.
- The image installs the published npm package (`AGEND_VERSION`: `latest` for the newest stable, `beta`, or an exact version). AgEnD itself has nothing Docker-specific.

## What the agent asks you

- Which AI backends to install (`claude-code`, `codex`, `kiro-cli`, `grok`, `opencode`, `antigravity`, `muse`), and whether to pin a CLI version.
- Web only, or also a Telegram or Discord bot (then the bot token, the group or server id, and your user id).
- Linux, or Docker Desktop on macOS or Windows (WSL), and the CPU architecture.
- Which AgEnD version.

It needs `docker compose` v2.24 or newer. Tokens and API keys go only in `.env`, never in `fleet.yaml` or a chat.

## Keep it running

| Do | How |
|---|---|
| Update AgEnD | set `AGEND_VERSION` in `.env` (or keep `latest`), then `docker compose build --pull --no-cache` and `docker compose up -d` |
| Restart, stop, start | `docker compose restart`, `docker compose stop`, `docker compose up -d` |
| Back up | while stopped, the runbook's steps pack the volumes into tar files |

**Never** run `agend update`, `agend restart`, `agend stop` or `agend install` inside the container, and don't send `/update` in the chat: the container has no systemd, and an update inside it is rolled back by the next start of the image. The fleet's daily "new version available" notice still says `/update`; update by rebuilding instead.

## What works in Docker

| | Regular install | Docker |
|---|:-:|:-:|
| Web dashboard and web chat | ✅ | ✅ |
| Telegram / Discord | ✅ | ✅ |
| All seven backends | ✅ | ✅ |
| `/login` for claude-code, codex, kiro-cli, grok | ✅ | ✅ |
| `agend update` / `/update` | ✅ | ❌ |
| `agend restart` / `stop` / `install` | ✅ | ❌ |
| A systemd / launchd service | ✅ | ❌ |
| `sudo` inside an instance's work | ✅ | ❌ |

The runbook also covers logs, watching or typing into an instance, adding a backend or an instance, and troubleshooting (including a WSL bind-mount trap).
