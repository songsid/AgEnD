#!/bin/sh
# usage: start.sh <before|after> <code-dir>
V=$1; CODE=$2; E=$(cd "$(dirname "$0")" && pwd); R=/tmp/ag154/$V
export AGEND_TMUX_BIN=${AGEND_TMUX_BIN:-$(command -v tmux)} AGEND_HOME=$R/d HOME=$R/home PATH=$R/home/.local/bin:$R/home/.grok/bin:$R/home/.opencode/bin:/usr/local/bin:/usr/bin:/bin AGEND_WSL=0
unset CLAUDECODE CLAUDE_CODE_ENTRYPOINT CLAUDE_CODE_SESSION_ID
cd "$CODE" && setsid nohup node dist/cli.js fleet start >> "$R/fleet.log" 2>&1 < /dev/null &
echo $! > "$R/fleet.pid"
