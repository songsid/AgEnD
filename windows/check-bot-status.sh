#!/bin/bash
# AgEnD Bot 狀態檢查腳本 - 回傳 JSON 給 Windows watchdog

CREDENTIALS="$HOME/.claude/.credentials.json"

# 1. 進程與 PID 檢查：tmux session 存在 + fleet.pid 指向的主進程確實在運行
PID_FILE="$HOME/.agend/fleet.pid"
FLEET_RUNNING=0
if tmux has-session -t agend 2>/dev/null; then
    if [ -f "$PID_FILE" ]; then
        MAIN_PID=$(cat "$PID_FILE")
        if kill -0 "$MAIN_PID" 2>/dev/null; then
            FLEET_RUNNING=1
        fi
    fi
fi
CLAUDE_COUNT=$(pgrep -c -f 'claude --settings' 2>/dev/null | tr -d '[:space:]' || echo 0)

# 2. log 錯誤檢查
LOG_ERROR=""
if tail -c 3000 "$HOME/.agend/instances/general/output.log" 2>/dev/null \
   | grep -qE "Not logged in|Login expired|organization has disabled"; then
    LOG_ERROR="logged_out"
fi

# 3. 一次 python3 呼叫完成所有 token 計算與判斷，輸出最終 JSON
python3 - "$FLEET_RUNNING" "$CLAUDE_COUNT" "$LOG_ERROR" "$CREDENTIALS" <<'EOF'
import json, sys, time

fleet    = int(sys.argv[1])
claude   = int(sys.argv[2])
log_err  = sys.argv[3]
creds_path = sys.argv[4]

status = "ok"
reason = ""
access_h = 0.0
refresh_d = 0.0

try:
    creds = json.load(open(creds_path))
    oauth = creds["claudeAiOauth"]
    now_ms       = int(time.time() * 1000)
    access_exp   = oauth["expiresAt"]
    refresh_exp  = oauth["refreshTokenExpiresAt"]
    access_h     = round((access_exp  - now_ms) / 3_600_000, 1)
    refresh_d    = round((refresh_exp - now_ms) / 86_400_000, 1)

    if fleet == 0:
        status, reason = "error", "fleet process or daemon PID not found"
    elif claude == 0:
        status, reason = "error", "claude process not found"
    elif log_err == "logged_out":
        status, reason = "error", "logged|claude logged out"
    elif now_ms >= access_exp:
        status, reason = "error", "expired|accessToken expired"
    elif (access_exp - now_ms) < 1_800_000:   # < 30 min → try refresh
        import subprocess
        subprocess.run(
            ["bash", "/mnt/c/Users/chunchenliu/Desktop/kiro/refresh-claude-token.sh"],
            capture_output=True
        )
        status, reason = "warning", "token refreshed"
except Exception as e:
    status, reason = "error", f"logged|cannot read credentials: {e}"

print(json.dumps({
    "status": status, "reason": reason,
    "fleet_running": fleet, "claude_count": claude,
    "access_remaining_hours": access_h,
    "refresh_remaining_days": refresh_d
}))
EOF
