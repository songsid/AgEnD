#!/bin/bash
# 自動 refresh claude accessToken（一次 python3 呼叫完成所有工作）

CREDENTIALS="$HOME/.claude/.credentials.json"
LOG="$HOME/.agend/autostart.log"
log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" | tee -a "$LOG"; }

[ -f "$CREDENTIALS" ] || { log "❌ 找不到 credentials，請先執行 claude /login"; exit 1; }

python3 - "$CREDENTIALS" "$LOG" <<'EOF'
import json, sys, time, subprocess

creds_path, log_path = sys.argv[1], sys.argv[2]

def log(msg):
    line = f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {msg}"
    print(line)
    with open(log_path, "a") as f:
        f.write(line + "\n")

try:
    creds  = json.load(open(creds_path))
    oauth  = creds["claudeAiOauth"]
    now_ms = int(time.time() * 1000)
    access_exp  = oauth["expiresAt"]
    refresh_exp = oauth["refreshTokenExpiresAt"]
    refresh_tok = oauth["refreshToken"]
except Exception as e:
    log(f"❌ 讀取 credentials 失敗：{e}")
    sys.exit(1)

log(f"refreshToken 剩餘：{round((refresh_exp - now_ms)/86_400_000, 1)} 天")
log(f"accessToken  剩餘：{round((access_exp  - now_ms)/3_600_000,  1)} 小時")

if now_ms >= refresh_exp:
    log("❌ refreshToken 已過期，請手動執行 claude /login")
    sys.exit(1)

if (access_exp - now_ms) >= 7_200_000:
    log("✅ accessToken 仍有效，不需要 refresh")
    sys.exit(0)

log("正在 refresh token...")
import urllib.request
req = urllib.request.Request(
    "https://claude.ai/api/auth/oauth/token",
    data=json.dumps({"grant_type": "refresh_token", "refresh_token": refresh_tok}).encode(),
    headers={"Content-Type": "application/json"},
    method="POST"
)
try:
    with urllib.request.urlopen(req, timeout=15) as r:
        resp = json.load(r)
except Exception as e:
    log(f"⚠️  Refresh 失敗：{e}，繼續用舊 token")
    sys.exit(0)

new_access = resp.get("access_token", "")
new_exp    = resp.get("expires_in", 0)
if not new_access:
    log(f"⚠️  Refresh 回應無 access_token：{resp}")
    sys.exit(0)

oauth["accessToken"] = new_access
oauth["expiresAt"]   = int((time.time() + new_exp) * 1000)
with open(creds_path, "w") as f:
    json.dump(creds, f, indent=4)
log(f"✅ accessToken 已更新，有效期 {new_exp} 秒")
EOF
