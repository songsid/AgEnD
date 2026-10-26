---
name: docker-install
description: Set up AgEnD in Docker for a person, or maintain one — follow the Docker runbook step by step
roles: [general]
---

## AgEnD in Docker

When a person wants AgEnD in Docker (a trial, a demo, a machine without Node.js), or asks you to maintain an existing
Docker install, follow the runbook exactly. It has the Dockerfile, entrypoint, compose file, CLI installs, first
fleet.yaml, verification, updates, backups and troubleshooting:

- English: https://github.com/songsid/AgEnD/blob/main/docs/docker.md
- 繁體中文: https://github.com/songsid/AgEnD/blob/main/docs/docker.zh-TW.md

Read the raw file (`https://raw.githubusercontent.com/songsid/AgEnD/main/docs/docker.md`) before you start, and run
every check it gives.

**Rules that hold even without the runbook at hand:**
- Never run `agend update`, `agend restart`, `agend stop` or `agend install` inside the container, and never `/update`
  in that fleet's chat. Update by rebuilding the image (`docker compose build --pull --no-cache && docker compose up -d`);
  restart with `docker compose restart`.
- Tokens and API keys go in the compose folder's `.env`, never in fleet.yaml or a chat.
- The dashboard stays published on `127.0.0.1` unless the person asks otherwise.
- AgEnD's data, the CLIs and their logins live in the `agend-home` volume: back it up before anything destructive.
