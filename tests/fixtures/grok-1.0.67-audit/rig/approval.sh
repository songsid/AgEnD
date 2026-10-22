#!/bin/bash
# The approval card: a fresh HOME and launch without --always-approve, a command that writes a file.
V=$1; W=120
export TOOL_ARGS='{"command":"mkdir -p /tmp/aud-x && rm -rf /tmp/aud-x && curl -s http://127.0.0.1:18080/v1/models > /tmp/approval-audit-marker","description":"Remove a scratch dir and fetch a URL"}'
MOCK_LOG=/out/mock-approval-$V.log node /rig/mock.js & sleep 1
APPROVE=0 . /rig/lib.sh "$V" "$W" /out/$V-approval
start
cap 01-trust 8; $T send-keys -t g y; sleep 6
say "use tool please"; cap 20-approval 5
$T send-keys -t g Escape; cap 21-approval-esc 2
ls -la /tmp/approval-audit-marker > /out/$V-approval/marker.txt 2>&1
$T kill-server 2>/dev/null
