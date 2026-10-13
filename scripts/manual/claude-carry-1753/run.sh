#!/bin/bash
# #1753 live-binary probe: does the real claude resume a conversation carried into another CLAUDE_CONFIG_DIR?
# No account: a local Messages mock (mock.py) and a dummy key, scratch HOME and config dirs; nothing leaves the host.
#   1. config A: one turn ("remember the word PELICAN") → A/projects/<cwd key>/<sid>.jsonl
#   2. carry A → B with the production carryClaudeConversation
#   3. config B: `claude -p --continue` → the mock must receive the earlier turn (PELICAN), same sessionId appended in B
#   4. control, config C with nothing carried: `--continue` starts with no history (PELICAN not seen)
# Usage: scripts/manual/claude-carry-1753/run.sh   (CLAUDE_BIN=/path/to/claude to pick a binary; PORT=18753)
set -u
P=$(cd "$(dirname "$0")" && pwd); REPO=$(cd "$P/../../.." && pwd)
CLAUDE_BIN=${CLAUDE_BIN:-$(command -v claude)}; PORT=${PORT:-18753}
R=$(mktemp -d); mkdir -p $R/home $R/A $R/B $R/C $R/work
python3 -I $P/mock.py $PORT $R/requests.log & MP=$!
trap 'kill $MP 2>/dev/null' EXIT
sleep 1
CL() { local dir=$1 prompt=$2; shift 2; (cd $R/work && printf '%s' "$prompt" | env -i HOME=$R/home PATH=/usr/bin:/bin TERM=dumb CLAUDE_CONFIG_DIR=$dir ANTHROPIC_BASE_URL=http://127.0.0.1:$PORT ANTHROPIC_API_KEY=dummy-key-aaaa DISABLE_AUTOUPDATER=1 CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 timeout 60 "$CLAUDE_BIN" -p "$@"); }
echo "claude: $("$CLAUDE_BIN" --version)   scratch: $R"
echo "--- 1. A: first turn"; CL $R/A "remember the word PELICAN" 2>&1 | grep -v "auto mode"
KEY=$(ls $R/A/projects/); SID=$(basename "$(ls $R/A/projects/$KEY/*.jsonl)" .jsonl); echo "sid=$SID"
echo "--- 2. carry A -> B"; (cd $REPO && node_modules/.bin/tsx $P/carry.mts $SID $R/work $R/A $R/B)
echo "--- 3. B: --continue"; CL $R/B "which word did I ask you to remember?" --continue 2>&1 | grep -v "auto mode"
echo "--- 4. control C (nothing carried): --continue"; CL $R/C "which word did I ask you to remember?" --continue 2>&1 | grep -v "auto mode"
echo "--- requests the mock received"; cat $R/requests.log
echo "--- transcripts"; for d in A B; do f=$R/$d/projects/$KEY/$SID.jsonl; echo "$d lines=$(wc -l <$f) $(grep -o '"sessionId":"[^"]*"' $f | sort -u | tr '\n' ' ')"; done
