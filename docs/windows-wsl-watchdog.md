# Windows + WSL Watchdog Setup

> Running AgEnD on Windows requires WSL2 (Ubuntu). The scripts in `windows/`
> keep the fleet alive automatically, handle token refresh, and alert you when
> the bot stops responding.

## Architecture

```
Windows 11
├── bot-watchdog.ps1          # Guardian process (PowerShell, Windows layer)
│   └── polls check-bot-status.sh every 300 s (up to 2 retries)
│       ├── status ok      → log and continue
│       ├── status warning → log and reset error counter
│       └── status error   → balloon / login dialog / auto-restart
│
├── start-bots.ps1            # One-click launcher (calls agend-start.sh via WSL)
├── install-autostart.ps1     # Registers Task Scheduler job at logon
│
└── WSL2 (Ubuntu)
    ├── agend-start.sh        # Fleet startup script
    │   └── clean → release port 19280 → wait for network → start fleet
    │
    ├── check-bot-status.sh   # Status probe — emits JSON
    │   └── checks: tmux session, fleet.pid alive, claude processes,
    │               log errors, accessToken expiry
    │
    ├── refresh-claude-token.sh  # Automatic OAuth token refresh
    │   └── runs at startup; also called by check-bot-status.sh < 30 min
    │
    └── agend fleet daemon    # Node.js Telegram bot process
        ├── Telegram polling
        ├── Web UI / Health endpoint: port 19280
        ├── Unix socket: channel.sock → routes to claude instances
        └── 4 claude CLI instances in tmux windows
```

## Prerequisites

| Requirement | Notes |
|---|---|
| Windows 10/11 | WSL2 must be enabled |
| WSL2 Ubuntu | `wsl --install -d Ubuntu` |
| Node.js ≥ 22.14 in WSL | Installed automatically by `install.sh` |
| agend installed globally | `npm install -g @songsid/agend` |
| claude CLI logged in | `claude /login` inside WSL |
| Python 3 | Pre-installed in Ubuntu |

## Scripts Overview

### `agend-start.sh`
Reliable fleet startup inside WSL. Called by `start-bots.ps1` and the watchdog.

Steps:
1. Log rotation (daemon.log > 8 000 lines → keep last 5 000)
2. Attempt token refresh via `refresh-claude-token.sh`
3. Kill any stale `agend fleet` / `claude` / tmux processes
4. Force-release port 19280 (`ss -lptn` — no `fuser` dependency)
5. Wait for Telegram API reachability (up to 60 s, IPv4)
6. Write `force_ipv4.js` Node.js preload (WSL2 DNS fix)
7. Start fleet with `NODE_OPTIONS=--require force_ipv4.js`
8. Wait up to 40 s for `polling started` or `Reconcile complete` in the log

### `check-bot-status.sh`
Returns a single-line JSON object. Called every 300 s by `bot-watchdog.ps1`.

```json
{
  "status": "ok | warning | error",
  "reason": "",
  "fleet_running": 1,
  "claude_count": 4,
  "access_remaining_hours": 7.2,
  "refresh_remaining_days": 13.4
}
```

Status rules:
| Condition | Status |
|---|---|
| All processes OK, token valid | `ok` |
| accessToken < 30 min → refresh attempted | `warning` |
| fleet PID missing or tmux gone | `error` |
| claude processes = 0 | `error` |
| Log contains "Not logged in" | `error` (reason: `logged\|…`) |
| accessToken expired | `error` (reason: `expired\|…`) |

### `refresh-claude-token.sh`
Reads `~/.claude/.credentials.json` and calls `https://claude.ai/api/auth/oauth/token`
with the stored `refreshToken`. Updates `accessToken` and `expiresAt` in-place.

- Skips if `accessToken` has > 2 h remaining
- Exits non-zero only when `refreshToken` itself is expired (manual `/login` required)

### `bot-watchdog.ps1`
Background PowerShell process. Runs as a Windows tray-aware loop.

Behaviour:
- Calls `check-bot-status.sh` via `wsl -d Ubuntu bash -lic "bash …"` with 2 retries
- On **error** (≥ 2 consecutive, cooldown 30 min):
  - `reason` matches `logged|expired` → shows a dark-mode "Re-login" dialog
  - Otherwise → balloon notification + calls `agend-start.sh` to auto-restart
- On **warning** → resets error counter, logs only
- Dark-mode Windows Forms UI (no external dependencies)

### `start-bots.ps1`
Thin launcher — runs `agend-start.sh` through WSL and prints summary output.
Useful for a manual start from Explorer or the Start Menu.

### `install-autostart.ps1`
Registers a Windows Task Scheduler job that runs `start-bots.ps1` at logon
with a 30-second delay (waits for WSL + network to be ready).

Run once as a regular user (no admin required):

```powershell
.\install-autostart.ps1
```

To test immediately after installing:

```powershell
Start-ScheduledTask -TaskName "AgEnD-Bot-Autostart"
```

To remove:

```powershell
Unregister-ScheduledTask -TaskName "AgEnD-Bot-Autostart" -Confirm:$false
```

## Initial Setup

```powershell
# 1. In PowerShell — start the watchdog
powershell -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass `
  -File "C:\path\to\windows\bot-watchdog.ps1"

# 2. Register autostart (optional)
powershell -ExecutionPolicy Bypass -File "C:\path\to\windows\install-autostart.ps1"
```

```bash
# Inside WSL Ubuntu — first-time login
claude /login
```

## Known Issues and Fixes

| Issue | Root Cause | Fix |
|---|---|---|
| WSL unreachable (no JSON from check script) | WSL slow to start after resume | Watchdog retries twice; ignores one miss |
| Telegram not reachable after WSL start | WSL2 DNS resolves to IPv6 | `force_ipv4.js` preload + curl `-4` flag |
| Port 19280 already in use after fast restart | Previous node process not fully exited | `agend-start.sh` uses `ss` to find and kill PID |
| `FLEET_RUNNING=1` even when daemon crashed | tmux session alive but PID gone | Dual check: tmux + `fleet.pid` kill-0 test |
| `warning` state accumulated error count | `errCount` not reset on warning | Fixed: both `ok` and `warning` reset counter |
| `daemon.log` grows to GB | No rotation | Rotation at 8 000 lines → keep 5 000 |

## Token Lifecycle

```
accessToken   — expires every ~8–12 h
refreshToken  — expires every ~14 days
```

- `refresh-claude-token.sh` handles daily rotation automatically.
- When `refreshToken` expires, the watchdog shows the "Re-login" dialog and
  launches `claude /login` in a tmux window, opens the browser, and waits for
  you to paste the OAuth code.
