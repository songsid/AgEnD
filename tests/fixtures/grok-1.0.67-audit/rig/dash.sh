#!/bin/bash
# The Agent Dashboard (never opened by AgEnD): `grok dashboard`, then "+ New Agent", to find the moved trust card.
V=$1; W=120
MOCK_LOG=/out/mock-dash-$V.log node /rig/mock.js & sleep 1
. /rig/lib.sh "$V" "$W" /out/$V-dashboard
FLAGS="--no-auto-update --always-approve"
mkdir -p /tmp/untrusted-$V && cd /tmp/untrusted-$V
$T new-session -d -s g -x $W -y 40 -c /tmp/untrusted-$V -e HOME="$HOME" -e XAI_API_KEY=xai-dummy-audit -e GROK_XAI_API_BASE_URL=http://127.0.0.1:18080/v1 -e XAI_API_BASE_URL=http://127.0.0.1:18080/v1 -e GROK_CLI_BASE_URL=http://127.0.0.1:18080 -e GROK_FOLDER_TRUST=1 -e TERM=xterm-256color "/bin/grok-$V $FLAGS dashboard"
$T set-option -t g remain-on-exit on >/dev/null
cap 01-open 8
$T send-keys -t g Enter; cap 02-enter 4
$T send-keys -t g Enter; cap 03-enter2 4
$T send-keys -t g Escape; cap 04-esc 2
$T kill-server 2>/dev/null
