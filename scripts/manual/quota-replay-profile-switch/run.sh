#!/bin/bash
# The 2026-11-06 quota-notice spam, end to end with the real claude (no account: a local Messages mock, scratch HOME and
# config dirs; nothing leaves the host). rig.mts carries a real conversation (with October usage-limit notes and a credit
# error in its history) across a profile switch with the production carryClaudeConversation, resumes it with the real
# claude in the new profile, and follows it with the production TranscriptMonitor + Daemon. Expect, after the fix:
#   RESULT replayed_notices=0 live_notices=1   (unfixed: replayed_notices=10)
# Usage: scripts/manual/quota-replay-profile-switch/run.sh [repo] [port]   (CLAUDE_BIN=/path/to/claude to pick a binary)
P=$(cd "$(dirname "$0")" && pwd); REPO=${1:-$(cd "$P/../../.." && pwd)}; PORT=${2:-18931}
R=$(mktemp -d)
python3 -I "$P/mock.py" "$PORT" "$R/requests.log" & MP=$!
trap 'kill $MP 2>/dev/null' EXIT
sleep 1
(cd "$REPO" && REPO="$REPO" CLAUDE_BIN="${CLAUDE_BIN:-$(command -v claude)}" PORT="$PORT" R="$R" timeout 300 node_modules/.bin/tsx "$P/rig.mts")
echo "--- mock requests"; cat "$R/requests.log"
