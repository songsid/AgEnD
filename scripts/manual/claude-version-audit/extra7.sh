# 2.1.327 audit, eighth pass: 2.1.327 changed the arrow keys on most permission prompts to stop at No instead of
# wrapping ("a number past the last answer moves to No"), and gave "Switch model?" key hints. Captures the model switch
# confirmation (#1690) and the Bash permission prompt, then presses past each list's ends to record the new stop.
# Run after extra.sh (it reuses pass1's k homes). Same rig: private tmux socket, isolated HOMEs, local mock.
set -u; . "$(dirname "$0")/lib.sh"
fresh() { rm -rf "${A:?}/h/$1"; cp -a "$A/h/k$2" "$A/h/$1"; }
capb() { for v in $OLD $NEW; do cap $1$v | sed 's/[[:space:]]*$//' > $A/cap/$v-$2.txt; done
  if diff <(norm $A/cap/$OLD-$2.txt) <(norm $A/cap/$NEW-$2.txt) > $A/cap/diff-$2.txt; then echo "[$2] SAME"; else echo "[$2] DIFF ($(wc -l < $A/cap/diff-$2.txt) lines)"; fi; }
waitfor() { local s=$1 re=$2 n=$(( $3 * 10 )) i=0; while [ $i -lt $n ]; do cap $s | grep -qE "$re" && { echo "$s ready after $((i * 100)) ms"; return 0; }; sleep 0.1; i=$((i + 1)); done; echo "$s TIMEOUT waiting for $re"; return 1; }
trust() { local s=$1 i=0; while [ $i -lt 40 ]; do local p; p=$(cap $s)
    if ! grep -q 'Yes, I trust this folder' <<<"$p"; then echo "$s trusted after $i steps"; return 0; fi
    if grep -qE '❯ No, exit' <<<"$p"; then keys $s Down; elif grep -qE '❯ Yes, I trust this folder' <<<"$p"; then keys $s Enter; fi
    sleep 0.5; i=$((i + 1)); done; echo "$s TRUST NOT ANSWERED"; return 1; }
# (a) Switch model? — a reply on sonnet warms the cache, then /model opus.
for v in $OLD $NEW; do fresh sm$v $v; printf '{\n  "theme": "dark",\n  "model": "sonnet"\n}\n' > $A/h/sm$v/.claude/settings.json; WITHKEY=1 start sm$v 2.1.$v $A/h/sm$v $A/w/sm$v; done
sleep 1; for v in $OLD $NEW; do waitfor sm$v 'trust this folder' 30 > /dev/null; trust sm$v; done; sleep 3
for v in $OLD $NEW; do paste sm$v "hello from the audit"; sleep 0.5; keys sm$v Enter; done; sleep 5
for v in $OLD $NEW; do paste sm$v "/model opus"; sleep 0.5; keys sm$v Enter; done; sleep 3; capb sm 160-switch-model
for v in $OLD $NEW; do keys sm$v Down; sleep 0.3; keys sm$v Down; done; sleep 1; capb sm 161-switch-model-down-past-end
for v in $OLD $NEW; do keys sm$v Up; sleep 0.3; keys sm$v Up; done; sleep 1; capb sm 162-switch-model-up-past-start
for v in $OLD $NEW; do keys sm$v Escape; done; sleep 2; capb sm 163-switch-model-escaped
for v in $OLD $NEW; do kill1 sm$v; done
# (b) the Bash permission prompt (--permission-mode default): Up past the first row, Down past the last.
for v in $OLD $NEW; do fresh bp$v $v; printf '{\n  "theme": "dark"\n}\n' > $A/h/bp$v/.claude/settings.json; WITHKEY=1 start bp$v 2.1.$v $A/h/bp$v $A/w/bp$v --permission-mode default; done
sleep 1; for v in $OLD $NEW; do waitfor bp$v 'trust this folder' 30 > /dev/null; trust bp$v; done; sleep 3
for v in $OLD $NEW; do paste bp$v "BASHPERM again"; sleep 1; keys bp$v Enter; done; sleep 6; capb bp 164-bash-permission
for v in $OLD $NEW; do keys bp$v Up; done; sleep 1; capb bp 165-bash-permission-up-past-start
for v in $OLD $NEW; do keys bp$v Down; sleep 0.3; keys bp$v Down; sleep 0.3; keys bp$v Down; sleep 0.3; keys bp$v Down; done; sleep 1; capb bp 166-bash-permission-down-past-end
for v in $OLD $NEW; do keys bp$v Escape; done; sleep 2; capb bp 167-bash-permission-escaped
for v in $OLD $NEW; do kill1 bp$v; done
