# 2.1.306 audit, seventh pass: the API's 400 errors, each in a fresh session (in pass1 the 400 followed the 529 retries in
# one session and never reached the API). 2.1.306 "Fixed an API error being replaced by 'prompt is too long'": E400LONG is
# the real context-limit error, E400BAD another invalid_request_error that must keep its own text.
# Run after extra.sh (it reuses pass1's k homes). Same rig: private tmux socket, isolated HOMEs, local mock.
set -u; . "$(dirname "$0")/lib.sh"
fresh() { rm -rf "${A:?}/h/$1"; cp -a "$A/h/k$2" "$A/h/$1"; }
capb() { for v in $OLD $NEW; do cap $1$v | sed 's/[[:space:]]*$//' > $A/cap/$v-$2.txt; done
  if diff <(norm $A/cap/$OLD-$2.txt) <(norm $A/cap/$NEW-$2.txt) > $A/cap/diff-$2.txt; then echo "[$2] SAME"; else echo "[$2] DIFF ($(wc -l < $A/cap/diff-$2.txt) lines)"; fi; }
trust() { local s=$1 i=0; while [ $i -lt 40 ]; do local p; p=$(cap $s)
    if ! grep -q 'Yes, I trust this folder' <<<"$p"; then echo "$s trusted after $i steps"; return 0; fi
    if grep -qE '❯ No, exit' <<<"$p"; then keys $s Down; elif grep -qE '❯ Yes, I trust this folder' <<<"$p"; then keys $s Enter; fi
    sleep 0.5; i=$((i + 1)); done; echo "$s TRUST NOT ANSWERED"; return 1; }
n=150; for e in E400LONG E400BAD; do
  for v in $OLD $NEW; do fresh h$e$v $v; printf '{\n  "theme": "dark",\n  "skipDangerousModePermissionPrompt": true\n}\n' > $A/h/h$e$v/.claude/settings.json; WITHKEY=1 start h$e$v 2.1.$v $A/h/h$e$v $A/w/h$e$v --dangerously-skip-permissions; done
  sleep 1; for v in $OLD $NEW; do trust h$e$v; done; sleep 3
  for v in $OLD $NEW; do paste h$e$v "trigger $e now"; sleep 0.5; keys h$e$v Enter; done; sleep 6; capb h$e $n-$e
  for v in $OLD $NEW; do echo "-- 2.1.$v $e:"; cap h$e$v | grep -E '●|⎿|Error|error|too long' | head -4; kill1 h$e$v; done; n=$((n + 1))
done
