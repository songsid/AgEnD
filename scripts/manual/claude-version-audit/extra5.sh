# 2.1.306 audit, sixth pass (after extra4.sh): extra3.sh showed that keys sent the instant the startup trust dialog paints are dropped by
# both 2.1.304 and 2.1.306 (Down lost, sometimes the Enter kept). AgEnD answers that dialog one step at a time from the
# cursor it sees, so this pass does the same for trust, and then sends the keys AgEnD sends at once to the dialogs that
# appear later: the Bypass Permissions warning, the dangerous-command menu (Down, Enter in one go) and the MCP approval.
# Run after extra.sh (it reuses pass1's k homes). Same rig: private tmux socket, isolated HOMEs, local mock.
set -u; . "$(dirname "$0")/lib.sh"
fresh() { rm -rf "${A:?}/h/$1"; cp -a "$A/h/k$2" "$A/h/$1"; }
capb() { for v in $OLD $NEW; do cap $1$v | sed 's/[[:space:]]*$//' > $A/cap/$v-$2.txt; done
  if diff <(norm $A/cap/$OLD-$2.txt) <(norm $A/cap/$NEW-$2.txt) > $A/cap/diff-$2.txt; then echo "[$2] SAME"; else echo "[$2] DIFF ($(wc -l < $A/cap/diff-$2.txt) lines)"; fi; }
both() { for v in $OLD $NEW; do "$@" $v; done; }
waitfor() { local s=$1 re=$2 n=$(( $3 * 10 )) i=0; while [ $i -lt $n ]; do cap $s | grep -qE "$re" && { echo "$s ready after $((i * 100)) ms"; return 0; }; sleep 0.1; i=$((i + 1)); done; echo "$s TIMEOUT waiting for $re"; return 1; }
# trust <session>: AgEnD's steps, every 0.5 s — Down while the cursor is on "No, exit", Enter once it is on "Yes, I trust"
trust() { local s=$1 i=0; while [ $i -lt 40 ]; do local p; p=$(cap $s)
    if ! grep -q 'Yes, I trust this folder' <<<"$p"; then echo "$s trusted after $i steps"; return 0; fi
    if grep -qE '❯ No, exit' <<<"$p"; then keys $s Down; elif grep -qE '❯ Yes, I trust this folder' <<<"$p"; then keys $s Enter; fi
    sleep 0.5; i=$((i + 1)); done; echo "$s TRUST NOT ANSWERED"; return 1; }

# E. AgEnD's real timing on the dangerous-command menu: the runtime poll (every 5 s) first sees the menu 0–5 s after it
# paints, then sends Down, waits 200 ms, sends Enter. One fresh session per delay; the result is read 3 s later.
sE() { fresh $1$2 $2; printf '{\n  "theme": "dark",\n  "skipDangerousModePermissionPrompt": true\n}\n' > $A/h/$1$2/.claude/settings.json; WITHKEY=1 start $1$2 2.1.$2 $A/h/$1$2 $A/w/$1$2 --dangerously-skip-permissions; }
DELAYS="0 0.3 0.6 1 2 4"
i=0; for d in $DELAYS; do i=$((i + 1)); for v in $OLD $NEW; do sE ge$i $v; done; done; sleep 1
# 2.1.308 audit: under a dozen concurrent starts the trust dialog can paint after trust() first looks, and trust() then
# reported "trusted after 0 steps" too early (the DANGER paste landed on the dialog). Wait for the dialog first.
i=0; for d in $DELAYS; do i=$((i + 1)); for v in $OLD $NEW; do waitfor ge$i$v 'trust this folder' 30 > /dev/null; trust ge$i$v; done; done; sleep 3
i=0; for d in $DELAYS; do i=$((i + 1)); for v in $OLD $NEW; do paste ge$i$v "DANGER go"; sleep 0.5; keys ge$i$v Enter; done; done
i=0; for d in $DELAYS; do i=$((i + 1)); for v in $OLD $NEW; do
  ( waitfor ge$i$v 'Do you want to proceed\?' 20 > /dev/null && sleep $d && keys ge$i$v Down && sleep 0.2 && keys ge$i$v Enter
    sleep 3; p=$(cap ge$i$v)
    if grep -q 'Do you want to proceed' <<<"$p"; then r="MENU OPEN, cursor: $(grep -oE '❯ [12]\. (Yes|No)' <<<"$p")"
    elif grep -q 'Interrupted' <<<"$p"; then r="REJECTED"; else r="OTHER"; fi
    echo "[140-danger-timing] 2.1.$v delay ${d}s: $r"; cap ge$i$v | sed 's/[[:space:]]*$//' > $A/cap/$v-140-danger-timing-$d.txt ) &
done; done; wait
i=0; for d in $DELAYS; do i=$((i + 1)); for v in $OLD $NEW; do kill1 ge$i$v; done; done
