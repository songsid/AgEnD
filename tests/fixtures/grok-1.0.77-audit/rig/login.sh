#!/bin/bash
# Login surfaces: TUI without API key, `grok login`, `grok login --device-auth`, `grok models`.
set -u
BASE="${AUDIT_BASE:-/tmp/agend-grok-audit-1077}"
V=${1:-1.0.77}; W=${2:-120}
OUT="$BASE/out/$V-login"
mkdir -p "$OUT"
BIN="$BASE/bin/grok-$V"
T="tmux -L grokaudit1077"
HOME_LOGIN="$BASE/home-$V-login"; rm -rf "$HOME_LOGIN"; mkdir -p "$HOME_LOGIN"
WORK="$BASE/work-$V-login/repo"; rm -rf "$BASE/work-$V-login"; mkdir -p "$WORK"
cd "$WORK" && git init -q && git config user.email a@b && git config user.name audit && git commit -qm init --allow-empty
MOCK_LOG="$OUT/mock.log" node "$BASE/rig/mock.cjs" &
MOCK_PID=$!
sleep 1

env_common() {
  echo -n "-e HOME=$HOME_LOGIN -e GROK_XAI_API_BASE_URL=http://127.0.0.1:18080/v1 -e XAI_API_BASE_URL=http://127.0.0.1:18080/v1 -e GROK_CLI_BASE_URL=http://127.0.0.1:18080 -e GROK_FOLDER_TRUST=1 -e TERM=xterm-256color"
}

$T kill-session -t g 2>/dev/null || true
# 1) TUI without any API key (AgEnD login-screen path)
$T new-session -d -s g -x "$W" -y 40 -c "$WORK" \
  -e HOME="$HOME_LOGIN" \
  -e GROK_XAI_API_BASE_URL=http://127.0.0.1:18080/v1 \
  -e XAI_API_BASE_URL=http://127.0.0.1:18080/v1 \
  -e GROK_CLI_BASE_URL=http://127.0.0.1:18080 \
  -e GROK_FOLDER_TRUST=1 \
  -e TERM=xterm-256color \
  "$BIN --no-auto-update --always-approve"
$T set-option -t g remain-on-exit on >/dev/null
sleep 8
$T capture-pane -p -t g -J > "$OUT/01-tui-nokey.pane.txt"
# If trust, answer y and recapture
if grep -q "trust" "$OUT/01-tui-nokey.pane.txt"; then
  $T send-keys -t g y
  sleep 6
  $T capture-pane -p -t g -J > "$OUT/02-tui-nokey-after-trust.pane.txt"
fi
$T kill-session -t g 2>/dev/null || true

# 2) grok login (AgEnD LOGIN_FLOWS.grok.command)
$T new-session -d -s g -x "$W" -y 40 -c "$WORK" \
  -e HOME="$HOME_LOGIN" \
  -e GROK_XAI_API_BASE_URL=http://127.0.0.1:18080/v1 \
  -e XAI_API_BASE_URL=http://127.0.0.1:18080/v1 \
  -e GROK_CLI_BASE_URL=http://127.0.0.1:18080 \
  -e GROK_FOLDER_TRUST=1 \
  -e TERM=xterm-256color \
  "$BIN login"
$T set-option -t g remain-on-exit on >/dev/null
sleep 8
$T capture-pane -p -t g -J > "$OUT/03-grok-login.pane.txt"
$T kill-session -t g 2>/dev/null || true

# 3) grok login --device-auth (LOGIN_FLOWS.grok.deviceAuth)
$T new-session -d -s g -x "$W" -y 40 -c "$WORK" \
  -e HOME="$HOME_LOGIN" \
  -e GROK_XAI_API_BASE_URL=http://127.0.0.1:18080/v1 \
  -e XAI_API_BASE_URL=http://127.0.0.1:18080/v1 \
  -e GROK_CLI_BASE_URL=http://127.0.0.1:18080 \
  -e GROK_FOLDER_TRUST=1 \
  -e TERM=xterm-256color \
  "$BIN login --device-auth"
$T set-option -t g remain-on-exit on >/dev/null
sleep 8
$T capture-pane -p -t g -J > "$OUT/04-grok-login-device.pane.txt"
$T kill-session -t g 2>/dev/null || true

# 4) grok models (LOGIN_FLOWS.grok.authCheck) — no key, then dummy key
{
  HOME="$HOME_LOGIN" GROK_XAI_API_BASE_URL=http://127.0.0.1:18080/v1 \
    XAI_API_BASE_URL=http://127.0.0.1:18080/v1 GROK_CLI_BASE_URL=http://127.0.0.1:18080 \
    timeout 8 "$BIN" models
} > "$OUT/05-models-nokey.txt" 2>&1 || true
{
  HOME="$HOME_LOGIN" XAI_API_KEY=xai-dummy-audit GROK_XAI_API_BASE_URL=http://127.0.0.1:18080/v1 \
    XAI_API_BASE_URL=http://127.0.0.1:18080/v1 GROK_CLI_BASE_URL=http://127.0.0.1:18080 \
    timeout 8 "$BIN" models
} > "$OUT/06-models-dummykey.txt" 2>&1 || true

$T kill-server 2>/dev/null || true
kill "$MOCK_PID" 2>/dev/null || true
wait "$MOCK_PID" 2>/dev/null || true
echo "LOGIN_DONE $V"
ls -la "$OUT"
