---
name: fleet-restart
description: Fleet restart types, recovery from tmux crash, rate limit handling, safe update
roles: [general]
---

## Fleet Restart & Recovery

**Restart types:**
- `agend fleet restart` — graceful, in the same process: instances restart once idle (does **not** load new code)
- `agend fleet restart --reload` — full process restart: new code and new connections take effect
- `agend fleet restart <name>` — restart one instance now
- `agend reload` — SIGHUP hot-reload, reconciles instances without restarting the fleet process. **Do not run `agend reload` after `create_instance`** — the fleet reconciles automatically when the instance is created; a redundant reload sends SIGHUP and restarts every running instance.
- `restart_instance("<name>")` — single instance restart, reloads fleet.yaml first
- `agend restart` — restarts the AgEnD service itself (systemd / launchd / detached), not one instance

**From a fleet agent session**, `agend stop`, `agend restart`, `agend update`, `agend fleet stop` and `agend fleet restart` (without a name) affect every instance and are refused unless you pass `--yes`. Each is written to `restart-audit.log` first. `--force` is for an operator's own shell only.

**After tmux crash:**
- Fleet detects the tmux server's death and opens a recovery window: spawns and deliveries are held 30 s, then 2 min and 10 min if it crashes again (losing single windows while the server lives holds nothing)
- Some instances may fail to restart due to rate limits from simultaneous startup
- Fix: manually restart failed instances, or do another `agend fleet restart`
- Check failed instances: `agend ls` shows "stopped" status

**Rate limit recovery:**
- If the log shows `PTY error: …rate limit…`, or the notice "crashed 3+ times shortly after launch — paused for recovery", wait 1-2 minutes
- Then `restart_instance` the affected instance
- Do NOT restart all instances simultaneously — this worsens rate limits

## Safe Update & Restart

**Update AgEnD to latest version:**
```bash
agend update --yes            # from a fleet session: the installed channel's latest (a beta stays on beta), then restart
agend update --version 2.2.0 --yes  # a specific version
```

It installs the selected release, checks the install, and restarts the fleet service. `--alpha` / `--beta` / `--stable` pick a channel; details in docs/cli.md.

**Manual restart (if update isn't needed):**
```bash
agend fleet restart --yes           # graceful (SIGUSR2) — keeps sessions, reloads config
agend fleet restart --reload --yes  # full process restart — new code takes effect
```

**NEVER do:**
- `kill -9` on the fleet process (corrupts state)
- Edit fleet.yaml while fleet is restarting
- Run `agend update` while another update is in progress
