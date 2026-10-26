#!/bin/bash
# #2675 e2e: the real kiro 2.34.0 V3 TUI (offline mock agent, patched scratch tui.js), answered by the real sequencer.
. /tmp/k234/bin/lib.sh
mkdir -p $K/out; s=e2675; W=<checkout>
D() { (cd $W && npx tsx tests/fixtures/kiro-remote-card-2675/rig/drive.mts $s "$1"); }
C() { $T capture-pane -p -t $s | grep -v '^\s*$' | tail -${1:-6}; }
Q() { echo '{"kind":"MOCK_SESSION_UPDATE","event":{"type":"question_request","value":{"sessionId":"mock-session-id","toolCallId":"tool-q-'$1'","question":"'"$2"'","options":'"$3"'}}}'; }
END='{"kind":"COMPLETE_TURN","stopReason":"end_turn"}'
RICH='[{"title":"Staged rollout","description":"Ship to 10% of hosts first, then the rest","recommended":true},{"title":"All at once"},{"title":"Choose components","subOptions":[{"title":"api"},{"title":"web"}]}]'
work $K/work/e2675
molaunch $s 2.34.0 $K/homes/el-2.34.0 $K/work/e2675 120 --v3 --trust-all-tools --trust-workspace
sleep 14; $T send-keys -t $s Down; sleep 0.6; $T capture-pane -p -t $s | grep -q '❯ Yes, I accept' && $T send-keys -t $s Enter; sleep 4; echo "== ready"; C 4
echo "== 1 option 2"; say $s "ask one"; sleep 2; cmd $s "$(Q 1 'How should I deploy this change?' "$RICH")"; sleep 3; D '{"kind":"option","n":2}'; sleep 1; C 5; cmd $s "$END"; sleep 2
echo "== 2 typed answer"; say $s "ask two"; sleep 2; cmd $s "$(Q 2 'Which branch should I use?' '[{"title":"main"},{"title":"release"}]')"; sleep 3; D '{"kind":"text","text":"release, but only after\nthe freeze"}'; sleep 1; C 5; cmd $s "$END"; sleep 2
echo "== 3 sub-options only web"; say $s "ask three"; sleep 2; cmd $s "$(Q 3 'How should I deploy this change?' "$RICH")"; sleep 3; D '{"kind":"option","n":3}'; sleep 1; D '{"kind":"suboptions","only":2}'; sleep 1; C 5; cmd $s "$END"; sleep 2
echo "== 4 skip"; say $s "ask four"; sleep 2; cmd $s "$(Q 4 'Which branch should I use?' '[{"title":"main"},{"title":"release"}]')"; sleep 3; D '{"kind":"skip"}'; sleep 1; C 5; cmd $s "$END"; sleep 2
FORM='{"kind":"MOCK_SESSION_UPDATE","event":{"type":"mcp_elicitation_request","value":{"sessionId":"mock-session-id","toolCallId":"tool-elicit-5","requestId":"req-5","elicitation":{"mode":"form","message":"The audit server asks for a few values","requestedSchema":{"type":"object","properties":{"colour":{"type":"string","title":"Favourite colour","enum":["red","green"]},"note":{"type":"string","title":"A short note"}},"required":["colour"]}}}}}'
URL='{"kind":"MOCK_SESSION_UPDATE","event":{"type":"mcp_elicitation_request","value":{"sessionId":"mock-session-id","toolCallId":"tool-elicit-6","requestId":"req-6","elicitation":{"mode":"url","message":"Sign in to the audit service to continue","url":"https://example.invalid/authorize?state=audit"}}}}'
echo "== 5 input form: decline"; say $s "tool five"; sleep 2; cmd $s "$FORM"; sleep 3; D '{"kind":"decline"}'; sleep 1; C 4; cmd $s "$END"; sleep 2
echo "== 6 input url (cursor on Copy URL): decline"; say $s "tool six"; sleep 2; cmd $s "$URL"; sleep 3; D '{"kind":"decline"}'; sleep 1; C 4; cmd $s "$END"; sleep 2
echo "== 7 input url: cancel"; say $s "tool seven"; sleep 2; cmd $s "${URL//-6/-7}"; sleep 3; D '{"kind":"cancel"}'; sleep 1; C 4; cmd $s "$END"; sleep 2
echo "== transcript"; $T capture-pane -p -S -400 -t $s | grep -E "^  › |^• |^◆ |Cancelled|declin|cancel" | grep -v "Kiro is working" 
echo "== end"; C 4
$T kill-session -t $s
