#!/bin/bash
# Full capture for one version and width. Same steps as the 1.0.52 audit (tests/fixtures/grok-1.0.52-audit/README.md).
V=$1; W=$2
export MCP_TOOL_ARGS='{"tool_name":"agend-audit-grok__reply","tool_input":{"text":"hello from audit"}}'
export TOOL_ARGS='{"command":"echo tool-ok-marker","description":"Print a marker for the audit"}'
MOCK_LOG=/out/mock-$V-$W.log node /rig/mock.js & sleep 1
. /rig/lib.sh "$V" "$W" /out/$V-$W
start
cap 01-trust 8; $T send-keys -t g y
cap 02-ready 6
say "please stall a"; cap 03-busy-a 3; cap 04-done 9
say "stall forever b"; cap 05-busy-before-cancel 3; $T send-keys -t g C-c; cap 06-after-cancel 2
# Clear the composer if the cancelled prompt came back.
$T send-keys -t g C-u; sleep 0.5
for L in a b c d e f g h; do
  case $L in a) S=401;; b) S=402;; c) S=403;; d) S=426;; e) S=429;; f) S=500;; g) S=403-usage;; h) S=429-text;; esac
  say "error turn $L"; cap 07-err-$S 7
  if [ $L = b ]; then $T send-keys -t g Escape; cap 07-err-402-esc 1; $T send-keys -t g X; sleep 1; $T send-keys -t g Escape; sleep 0.5; fi
  if [ $L = f ]; then $T send-keys -t g C-c; sleep 1; fi
  $T send-keys -t g C-u; sleep 0.3
done
say "use tool please"; cap 09-tool 6
say "/compact "; cap 10-compact 2; sleep 6
say "/new"; cap 11-new 4
if [ "$W" = 120 ]; then
  say "mcp tool please"; cap 32-mcp-call 6
  $T send-keys -t g C-q; cap 50-quit-single 1
  $T send-keys -t g C-q; sleep 0.25; $T send-keys -t g C-q; cap 51-quit-double 3
  SID=$(grep -o 'grok --resume [0-9a-f-]*' "$OUT/51-quit-double.pane.txt" | awk '{print $3}' | head -1); echo "$SID" > "$OUT/session-id.txt"
  if [ -n "$SID" ]; then start "--resume $SID"; cap 52-resume 9; $T send-keys -t g C-q; sleep 0.25; $T send-keys -t g C-q; sleep 2; fi
  # The approval card: a fresh launch without --always-approve.
  APPROVE=0; FLAGS="--no-auto-update"; start
  sleep 8; $T send-keys -t g y; sleep 6
  say "use tool please"; cap 20-approval 5
  $T send-keys -t g Escape; sleep 1
fi
$T kill-server 2>/dev/null
cp "$HOME/.grok" -r /out/$V-$W-grokhome 2>/dev/null; ls -R "$HOME/.grok/sessions" > /out/$V-$W/sessions.txt 2>&1
