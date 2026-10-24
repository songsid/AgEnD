# elscen.sh <session> <ver> <width> <prefix>: the elicitation scenario on a ready mock session (patched scratch tui.js).
s=$1; v=$2; w=$3; p=$4
FORM='{"kind":"MOCK_SESSION_UPDATE","event":{"type":"mcp_elicitation_request","value":{"sessionId":"mock-session-id","toolCallId":"tool-elicit-ID","requestId":"req-ID","elicitation":{"mode":"form","message":"The audit server asks for a few values","requestedSchema":{"type":"object","properties":{"colour":{"type":"string","title":"Favourite colour","enum":["red","green","blue"],"enumNames":["Red","Green","Blue"]},"count":{"type":"integer","title":"How many","minimum":1,"maximum":9},"note":{"type":"string","title":"A short note"}},"required":["colour"]}}}}}'
URL='{"kind":"MOCK_SESSION_UPDATE","event":{"type":"mcp_elicitation_request","value":{"sessionId":"mock-session-id","toolCallId":"tool-elicit-ID","requestId":"req-ID","elicitation":{"mode":"url","message":"Sign in to the audit service to continue","url":"https://example.invalid/authorize?state=audit"}}}}'
QUESTION='{"kind":"MOCK_SESSION_UPDATE","event":{"type":"question_request","value":{"sessionId":"mock-session-id","toolCallId":"tool-q-ID","question":"Which branch should I use?","options":[{"label":"main","value":"main"},{"label":"release","value":"release"}]}}}'
END='{"kind":"COMPLETE_TURN","stopReason":"end_turn"}'
turn() { say $s "$1"; sleep 2; }
turn "run the audit tool please (form)"; cmd $s "${FORM//ID/1}"; sleep 3; cap $s $p-10-form
# What an AgEnD delivery does to an OPEN form: paste the message (bracketed), then Enter.
$T set-buffer -b d -- "hello from agend"; $T paste-buffer -p -d -b d -t $s; sleep 0.8; cap $s $p-11-form-paste
$T send-keys -t $s Enter; sleep 1.5; cap $s $p-12-form-paste-enter
$T send-keys -t $s Escape; sleep 1.5; cap $s $p-13-form-esc
cmd $s "$END"; sleep 2; cap $s $p-19-after-turn
turn "run the audit tool please (url)"; cmd $s "${URL//ID/2}"; sleep 3; cap $s $p-20-url
$T send-keys -t $s Escape; sleep 1.5; cap $s $p-21-url-esc
cmd $s "$END"; sleep 2
turn "ask me a question"; cmd $s "${QUESTION//ID/3}"; sleep 3; cap $s $p-30-question
$T send-keys -t $s Escape; sleep 1.5; cap $s $p-31-question-esc
cmd $s "$END"; sleep 2; cap $s $p-39-end
