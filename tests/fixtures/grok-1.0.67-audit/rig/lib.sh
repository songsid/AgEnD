# Shared rig steps (inside the network-none container). Args: VERSION WIDTH OUT; optional APPROVE=0 to drop --always-approve.
set -u
V=$1; W=$2; OUT=$3; mkdir -p "$OUT"
export HOME=/tmp/home-$V-$W; rm -rf "$HOME"; mkdir -p "$HOME"
WORK=/tmp/work-$V-$W/repo; rm -rf /tmp/work-$V-$W; mkdir -p "$WORK" /tmp/inst-$V-$W
T="tmux -L grokaudit"
cd "$WORK" && git init -q && git config user.email a@b && git config user.name audit
cat > /tmp/inst-$V-$W/mcp-wrapper-agend.sh <<EOS
#!/bin/bash
export AGEND_INSTANCE_NAME='audit-grok'
exec node /rig/mcp-stub.js
EOS
chmod 700 /tmp/inst-$V-$W/mcp-wrapper-agend.sh
printf '{\n  "mcpServers": {\n    "agend-audit-grok": {\n      "command": "/tmp/inst-%s-%s/mcp-wrapper-agend.sh",\n      "args": []\n    }\n  }\n}' "$V" "$W" > .mcp.json
printf '<!-- AGEND:audit-grok:BEGIN -->\n# Fleet instructions (audit)\nReply briefly.\n<!-- AGEND:audit-grok:END -->\n' > AGENTS.md
git add -A && git commit -qm init
FLAGS="--no-auto-update"; [ "${APPROVE:-1}" = 1 ] && FLAGS="$FLAGS --always-approve"
cap() { sleep "${2:-0}"; $T capture-pane -p -t g > "$OUT/$1.pane.txt"; }
say() { $T set-buffer -b p -- "$1"; $T paste-buffer -p -d -b p -t g; sleep 0.4; $T send-keys -t g Enter; }
start() {
  $T kill-session -t g 2>/dev/null
  $T new-session -d -s g -x "$W" -y 40 -c "$WORK" -e HOME="$HOME" -e XAI_API_KEY=xai-dummy-audit -e GROK_XAI_API_BASE_URL=http://127.0.0.1:18080/v1 -e XAI_API_BASE_URL=http://127.0.0.1:18080/v1 -e GROK_CLI_BASE_URL=http://127.0.0.1:18080 -e GROK_FOLDER_TRUST=1 -e TERM=xterm-256color "/bin/grok-$V $FLAGS ${1:-}"
  $T set-option -t g remain-on-exit on >/dev/null
}
