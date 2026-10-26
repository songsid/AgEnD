# AgEnD in Docker: how the runbook was settled and checked (#581)

## What ships

One document: [docker.md](../docker.md), with [docker.zh-TW.md](../docker.zh-TW.md). It is a runbook an agent follows to
set up AgEnD in Docker for a person and to maintain it. The `docker-install` General skill points agents to it.
Nothing in AgEnD's code is specific to Docker.

## History

- The first design (#581) added a container mode to AgEnD: an image with `AGEND_CONTAINER=1`,
  `agend container prepare`, refusals of `update`/`stop`/`install` inside the container, and a configurable dashboard
  bind address. It merged as #2697 (d67083fa).
- The user then asked for the runbook only, with no product code (hmsg-ad04f86f, hmsg-835fa0d3). The PR that added this
  page reverts #2697's code. No release contained it: the newest beta at the time was 2.3.2-beta.11 (a5da7f88).
- The design work still informs the runbook:
  - tini as PID 1 (a non-reaping PID 1 leaves a killed CLI as a zombie that holds its session lock);
  - non-root uid 1000;
  - named volumes, with the WSL bind-mount trap;
  - the CLIs' self-updates turned off;
  - the claude-code and kiro-cli pins.
- What the runbook does without product code:
  - The dashboard listens only on 127.0.0.1, so a `socat` forwarder in the entrypoint makes it reachable through the
    published port.
  - Self-update and service commands are the agent's rules, not refusals in code.

## The runbook, verified on its own (2026-10-26)

The run extracted the Dockerfile, entrypoint, compose file, `.env` and `fleet.yaml` from the runbook's
`<!-- file: … -->` blocks verbatim, then ran the runbook's commands in order. The only deviations were this host's:
- everything named `agend-dq-*`;
- host port 19381;
- claude pointed at a local mock Anthropic API (no real account), which answers through AgEnD's `reply` tool.

A browser (Playwright) signed in with `agend web --code` and checked each round trip. The run finished with exit 0,
and everything was removed afterwards.

| Runbook step | Result |
|---|---|
| 2: build from npm `latest` (2.3.1) | ✅ |
| 3: the image runs as uid 1000 with AgEnD and tmux | ✅ |
| 4: claude-code (unpinned, 2.1.310) and kiro-cli pinned 2.34.0 (tarball) install into the volume | ✅ |
| 5: fleet.yaml copied in as the container user; `agend validate` has no errors | ✅ |
| 6: `up -d` → healthy; tmux windows; `agend web --code`; browser round trip | ✅ 0.75 s |
| `docker compose restart` → round trip | ✅ |
| CLI pin change (claude-code → 2.1.296) + restart → round trip | ✅ |
| AgEnD update by rebuild (`AGEND_VERSION=2.3.2-beta.11`) → `agend --version` 2.3.2-beta.11, the CLI kept, round trip | ✅ |
| Logs (`docker compose logs`, `.agend/daemon.log`, instance folders) | ✅ |
| Back up both volumes, `down -v`, restore, `up -d` → round trip | ✅ |
| The forwarder (`pgrep -a socat`) | ✅ |

The earlier prototype's checks (with the container-mode code) also covered every other backend's installer inside
the image: codex, grok, opencode, antigravity and muse each installed and ran. Its installer commands are the
runbook's step 4.

Not covered: real vendor sign-ins, real bot tokens, tunnels, and arm64.
