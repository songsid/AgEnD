# Docker quick install: design and end-to-end check (#581)

The design is on [#581](https://github.com/songsid/AgEnD/issues/581#issuecomment-6414377894). The user docs are
[docker.md](../docker.md) and [docker.zh-TW.md](../docker.zh-TW.md). This page records how the prototype was checked.

## What is in the repository

| File | Role |
|---|---|
| `docker/Dockerfile` | `node:22-bookworm-slim` + tmux, git, curl, xz, unzip, less, tini; `npm i -g` AgEnD (`AGEND_PACKAGE`: a version, or an `npm pack` tarball for a local build); the base image's uid-1000 user renamed `agend`; `AGEND_CONTAINER=1`, `AGEND_WEB_BIND=0.0.0.0`, the CLIs' self-updates off; tini as PID 1 |
| `docker/agend-container` | the entrypoint: runs its arguments if any; else checks the home is owned and writable, `agend container prepare`, `exec agend fleet start` |
| `docker/build-from-checkout.sh`, `docker/.dockerignore` | until the image is published: build it from a checkout (`npm pack` → `AGEND_PACKAGE=/ctx/<tgz> docker compose build`); `.env` never enters the build context |
| `docker/compose.yaml`, `docker/.env.example` | one service, `restart: unless-stopped`, `127.0.0.1:19280` published, named volumes `agend-home` and `agend-work` |
| `src/container.ts` | container mode: the dashboard's listen address, the refusals of `update` / `install` / `stop`, `restart` by Docker's restart policy |
| `src/container-prepare.ts` | `agend container prepare`: the first fleet.yaml from the environment, and the CLI installs with pins |
| `scripts/manual/docker-quick-install/` | the e2e: `run-e2e.sh`, the mock Anthropic API, the browser leg |

## The end-to-end run (2026-10-26)

`scripts/manual/docker-quick-install/run-e2e.sh`, on a Linux Docker host (Docker 29, Compose 5.3). It used no real vendor
account and no bot token: claude talked to `mock-anthropic.mjs` on a private network. Everything was named
`agend-dq-*` and removed afterwards.

| Step | Result |
|---|---|
| Image built from this checkout (`npm pack`) | ✅ |
| First `compose up`: fleet.yaml written from `.env`, claude-code installed by `agend container prepare` | ✅ (claude 2.1.310) |
| The dashboard from the host (`127.0.0.1:19381` → 19280) | ✅ `/health` 200 |
| The fleet runs as uid 1000 under tini (PID 1) | ✅ |
| Sign-in with `agend web --code`, a message in the web chat, the reply back | ✅ in 0.79 s |
| `agend update`, `agend stop` in the container | ✅ refused, with the `docker compose` line |
| `agend restart`: Docker restarts the container; the CLI is not installed again | ✅ restart count 1, round trip again ✅ |
| `compose down` + `up`: the home volume keeps the CLI and the fleet | ✅ round trip again ✅ |
| Every other backend installs and runs in the image | ✅ codex 0.164.0, opencode, antigravity, grok 1.0.70, muse 1.4.13 |
| Pins | ✅ claude-code 2.1.296, kiro-cli 2.34.0 (the release tarball) |
| `kiro-cli chat --tui` starts in the container | ✅ reaches kiro's own sign-in screen |

The round trip: claude 2.1.310 defers MCP tools, so the mock answers the person's message with a `ToolSearch` for
`mcp__agend__reply`, then calls it with `pong: <message>`. The reply came back to the web chat through AgEnD.

Not covered: real vendor sign-ins, real bot tokens, tunnels, and arm64. These need accounts, or a later build.

## Running it again

```bash
npm run build
DOCKER_CONFIG=<a config.json without credsStore, on WSL> PW_DIR=<dir with playwright-core> CHROME=<chrome> \
  FONTCONFIG_FILE=/etc/fonts/fonts.conf scripts/manual/docker-quick-install/run-e2e.sh
```

On WSL with Docker Desktop, the credential helper (`docker-credential-desktop.exe`) cannot run from Linux, so a
public-image pull fails. A scratch `DOCKER_CONFIG` holding `{}` avoids it.

## Publishing (proposed, not enabled)

A job after the npm publish in `publish.yml`, gated on an explicit input until the user approves:

```yaml
  docker-image:
    needs: publish
    if: ${{ inputs.publish_image == true }}   # off until approved
    runs-on: ubuntu-latest
    permissions: { contents: read, packages: write }
    steps:
      - uses: actions/checkout@<pinned sha>
      - uses: docker/setup-buildx-action@<pinned sha>
      - uses: docker/login-action@<pinned sha>
        with: { registry: ghcr.io, username: ${{ github.actor }}, password: ${{ secrets.GITHUB_TOKEN }} }
      - uses: docker/build-push-action@<pinned sha>
        with:
          context: docker
          platforms: linux/amd64,linux/arm64
          build-args: AGEND_PACKAGE=@songsid/agend@${{ needs.publish.outputs.version }}
          push: true
          tags: |
            ghcr.io/songsid/agend:${{ needs.publish.outputs.version }}
            ghcr.io/songsid/agend:${{ needs.publish.outputs.channel }}   # latest or beta, as on npm
```
