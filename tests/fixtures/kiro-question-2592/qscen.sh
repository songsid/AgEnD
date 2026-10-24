# qscen.sh <session> <ver> <width> <prefix>: the agent's Question card on a ready mock session (patched scratch tui.js).
s=$1; v=$2; w=$3; p=$4
Q() { echo '{"kind":"MOCK_SESSION_UPDATE","event":{"type":"question_request","value":{"sessionId":"mock-session-id","toolCallId":"tool-q-'$1'","question":"'"$2"'","options":'"$3"'}}}'; }
END='{"kind":"COMPLETE_TURN","stopReason":"end_turn"}'
turn() { say $s "$1"; sleep 2; }
turn "ask me (basic)"; cmd $s "$(Q 1 'Which branch should I use?' '[{"title":"main"},{"title":"release"}]')"; sleep 3; cap $s $p-40-question
# What an AgEnD delivery does to the card: paste the message (bracketed), then Enter.
$T set-buffer -b d -- "hello from agend"; $T paste-buffer -p -d -b d -t $s; sleep 0.8; cap $s $p-41-question-paste
$T send-keys -t $s Enter; sleep 1.5; cap $s $p-42-question-paste-enter
cmd $s "$END"; sleep 2; cap $s $p-43-after-turn
turn "ask me (rich)"; cmd $s "$(Q 2 'How should I deploy this change?' '[{"title":"Staged rollout","description":"Ship to 10% of hosts first, then the rest","recommended":true},{"title":"All at once"},{"title":"Choose components","subOptions":[{"title":"api"},{"title":"web"}]}]')"; sleep 3; cap $s $p-50-question-rich
$T send-keys -t $s Down; sleep 0.4; $T send-keys -t $s Down; sleep 0.4; $T send-keys -t $s Enter; sleep 1.5; cap $s $p-51-question-suboptions
$T send-keys -t $s Escape; sleep 1; cap $s $p-52-question-suboptions-back
$T send-keys -t $s Escape; sleep 1.5; cap $s $p-53-question-esc
cmd $s "$END"; sleep 2; cap $s $p-59-end
