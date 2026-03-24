# Design: `ccd export` / `ccd import`

## Purpose

Enable migrating claude-channel-daemon configuration between devices with two CLI commands.

## Commands

### `ccd export [output-path]`

- Default output: `ccd-export-{YYYY-MM-DD}.tar.gz` in current directory
- **Default (minimal):** packs only `fleet.yaml`, `.env`, `scheduler.db`
- **`--full` flag:** packs entire `~/.claude-channel-daemon/` excluding runtime files (`*.sock`, `*.pid`, `*.log`, `output.log`)
- Prints warning that tarball contains secrets (bot token, API keys)
- Prints file path and size on completion

### `ccd import <file>`

- Extracts to `~/.claude-channel-daemon/`
- If `fleet.yaml` or `.env` already exist, backs them up as `{filename}.bak.{timestamp}`
- After extraction, parses `fleet.yaml` and checks all paths:
  - `project_roots[]`
  - `instances.*.working_directory`
  - `sandbox.extra_mounts[]` (left side of colon)
- Lists any non-existent paths as warnings

## Security

- Export prints a warning: tarball contains `CCD_BOT_TOKEN` and `GROQ_API_KEY`
- No encryption (user handles transport security)

## Out of scope

- Dockerfile.sandbox / node_modules (live in the git repo)
- Automatic path correction
- Encryption
