#!/bin/bash
# AgEnD Fleet 可靠啟動腳本（在 WSL 內執行）
# 負責：清理殘留進程 -> 等待網路 -> 啟動 fleet
set -u

# 載入 nvm 讓 agend / node 可用（非互動 shell 需要）
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

LOG="$HOME/.agend/autostart.log"
DAEMON_LOG="$HOME/.agend/daemon.log"
mkdir -p "$HOME/.agend"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" | tee -a "$LOG"; }

log "=== AgEnD 自動啟動開始 ==="

# 0. Log rotation — 避免 daemon.log / autostart.log 無限成長
if [ -f "$DAEMON_LOG" ] && [ "$(wc -l < "$DAEMON_LOG")" -gt 8000 ]; then
    tail -n 5000 "$DAEMON_LOG" > "$DAEMON_LOG.tmp" && mv "$DAEMON_LOG.tmp" "$DAEMON_LOG"
    log "daemon.log rotated"
fi
if [ -f "$LOG" ] && [ "$(wc -l < "$LOG")" -gt 1000 ]; then
    tail -n 500 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
fi

# 1. 自動更新 Claude accessToken（避免每天要手動登入）
REFRESH_SCRIPT="/mnt/c/Users/chunchenliu/Desktop/kiro/refresh-claude-token.sh"
[ -f "$REFRESH_SCRIPT" ] && bash "$REFRESH_SCRIPT"

# 2. 清理任何殘留的 fleet / claude / tmux 進程，避免重複進程搶 port 與 polling
log "清理殘留進程與釋放埠口..."
pkill -9 -f 'agend fleet' 2>/dev/null
pkill -9 -f 'claude --settings' 2>/dev/null
pkill -9 -f 'tmux new-session -d -s agend' 2>/dev/null

# 強制釋放 port 19280（避免多次快速重啟造成埠口衝突與 daemon 靜默崩潰）
# 用 ss 取代 fuser，避免部分 WSL 映像檔未安裝 psmisc 套件
PID_19280=$(ss -lptn 'sport = :19280' 2>/dev/null | grep -oP 'pid=\K[0-9]+')
[ -n "$PID_19280" ] && kill -9 "$PID_19280" 2>/dev/null
rm -f "$HOME/.agend/fleet.pid" "$HOME"/.agend/instances/*/daemon.pid "$HOME/.agend/channel.sock" 2>/dev/null

sleep 3

log "清理後殘留進程數: $(ps aux | grep -E 'agend fleet|claude --settings' | grep -v grep | wc -l)"

# 3. 等待網路連通 Telegram API（WSL 剛啟動時網路常常還沒就緒）
log "等待網路就緒..."
NET_OK=0
for i in $(seq 1 30); do
  CODE=$(curl -4 -s -o /dev/null -w "%{http_code}" --max-time 5 "https://api.telegram.org" 2>/dev/null)
  if [ "$CODE" != "000" ] && [ -n "$CODE" ]; then
    log "網路就緒（第 $i 次嘗試，HTTP $CODE）"
    NET_OK=1
    break
  fi
  sleep 2
done

if [ "$NET_OK" != "1" ]; then
  log "警告：網路等待逾時，仍嘗試啟動（agend 會自動重試）"
fi

# 4. 產生 IPv4 修補腳本（僅首次或被刪時才寫入）
#    WSL2 DNS 解析 Telegram 為 IPv6，但 IPv6 不通
FORCE_IPV4="$HOME/.agend/force_ipv4.js"
if [ ! -f "$FORCE_IPV4" ]; then
    cat > "$FORCE_IPV4" << 'EOF'
// node.js preload: force Telegram API to resolve via IPv4
// WSL2 resolves telegram.org to IPv6, which is unreachable
'use strict';
const dns = require('dns');
if (typeof dns.setDefaultResultOrder === 'function') {
  dns.setDefaultResultOrder('ipv4first');
}
const _lookup = dns.lookup.bind(dns);
dns.lookup = function(hostname, options, callback) {
  if (typeof options === 'function') { callback = options; options = {}; }
  if (hostname && hostname.includes('telegram.org')) {
    options = (typeof options === 'object' && options)
      ? Object.assign({}, options, { family: 4 })
      : { family: 4 };
  }
  return _lookup(hostname, options, callback);
};
EOF
fi

# 5. 啟動 fleet（背景執行，輸出寫入 log）
export NODE_OPTIONS="--dns-result-order=ipv4first --require $FORCE_IPV4"
log "啟動 agend fleet..."
nohup agend fleet start >> "$LOG" 2>&1 &
FLEET_PID=$!

# 6. 等待啟動結果（最多 40 秒）
#    用 tail 讀最新幾行，避免 grep 掃整個大型 daemon.log
log "等待 fleet 啟動..."
for i in $(seq 1 20); do
  sleep 2
  if tail -20 "$DAEMON_LOG" 2>/dev/null | grep -q "polling started\|Reconcile complete"; then
    log "=== AgEnD 啟動成功，Bot polling 已連線 ==="
    exit 0
  fi
done

# 最終保底確認
if kill -0 "$FLEET_PID" 2>/dev/null || pgrep -f 'agend fleet start' >/dev/null; then
  log "=== AgEnD 啟動成功，fleet 進程運行中 ==="
else
  log "=== 警告：未偵測到 fleet 進程，請檢查 $DAEMON_LOG ==="
fi
