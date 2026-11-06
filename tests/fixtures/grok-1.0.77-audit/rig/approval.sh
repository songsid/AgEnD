#!/bin/bash
set -u
BASE="${AUDIT_BASE:-/tmp/agend-grok-audit-1077}"
V=$1; W=120
export TOOL_ARGS='{"command":"mkdir -p /tmp/aud-x && rm -rf /tmp/aud-x && curl -s http://127.0.0.1:18080/v1/models > /tmp/approval-audit-marker","description":"Remove a scratch dir and fetch a URL"}'
OUT="$BASE/out/$V-approval"
mkdir -p "$OUT"
MOCK_LOG="$OUT/mock.log" node "$BASE/rig/mock.cjs" &
MOCK_PID=$!
sleep 1
APPROVE=0
. "$BASE/rig/lib.sh" "$V" "$W" "$OUT"
start
cap 01-trust 8; $T send-keys -t g y; sleep 6
say "use tool please"; cap 20-approval 5
$T send-keys -t g Escape; cap 21-approval-esc 2
ls -la /tmp/approval-audit-marker > "$OUT/marker.txt" 2>&1 || true
$T kill-server 2>/dev/null || true
kill "$MOCK_PID" 2>/dev/null || true
wait "$MOCK_PID" 2>/dev/null || true
echo "APPROVAL_DONE $V"
