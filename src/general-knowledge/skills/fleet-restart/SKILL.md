---
name: fleet-restart
description: Fleet restart types, recovery from tmux crash, rate limit handling, safe update
---

## Fleet Restart & Recovery

**Restart types:**
- `agend fleet restart` — full stop + start (picks up new code after build & link)
- `agend reload` — SIGHUP hot-reload, reconciles instances without restarting the fleet process
- `restart_instance("<name>")` — single instance restart, reloads fleet.yaml first

**After tmux crash:**
- Fleet auto-detects tmux server death and triggers circuit breaker (30s pause)
- Some instances may fail to restart due to rate limits from simultaneous startup
- Fix: manually restart failed instances, or do another `agend fleet restart`
- Check failed instances: `agend ls` shows "stopped" status

**Rate limit recovery:**
- If you see "PTY error: Rate limit reached" or "crash loop — respawn paused", wait 1-2 minutes
- Then `restart_instance` the affected instance
- Do NOT restart all instances simultaneously — this worsens rate limits

## Safe Update & Restart

**Update AgEnD to latest version:**
```bash
agend update              # update to latest
agend update --version 0.0.6  # pin specific version
```

The `agend update` command automatically:
- Detects if sudo is needed (switches to nvm if so)
- Installs new version
- Verifies installation succeeded
- Updates service file (ExecStart path)
- Restarts fleet

**Manual restart (if update isn't needed):**
```bash
agend fleet restart       # graceful restart (SIGUSR2) — keeps sessions, reloads config
agend fleet stop && agend fleet start  # full restart — new code takes effect
```

**NEVER do:**
- `kill -9` on the fleet process (corrupts state)
- Edit fleet.yaml while fleet is restarting
- Run `agend update` while another update is in progress
