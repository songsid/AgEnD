# 2.1.306 audit, fifth pass: extra3.sh showed that keys sent the instant the startup trust dialog paints are dropped by
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

# B. Bypass Permissions warning: Down, Enter at once when it shows (AgEnD steps here too; this is the worst case).
sB() { fresh gb$1 $1; WITHKEY=1 start gb$1 2.1.$1 $A/h/gb$1 $A/w/gb$1 --dangerously-skip-permissions; }
both sB; sleep 1; for v in $OLD $NEW; do trust gb$v; done
for v in $OLD $NEW; do waitfor gb$v 'Bypass Permissions mode' 15 && keys gb$v Down Enter; done; sleep 4; capb gb 131-bypass-fast
for v in $OLD $NEW; do kill1 gb$v; done

# C. dangerous rm under bypass: AgEnD's Down, Enter (select No) in one go, the moment the menu shows.
sC() { fresh gc$1 $1; printf '{\n  "theme": "dark",\n  "skipDangerousModePermissionPrompt": true\n}\n' > $A/h/gc$1/.claude/settings.json; WITHKEY=1 start gc$1 2.1.$1 $A/h/gc$1 $A/w/gc$1 --dangerously-skip-permissions; }
both sC; sleep 1; for v in $OLD $NEW; do trust gc$v; done; sleep 3
for v in $OLD $NEW; do paste gc$v "DANGER go"; sleep 1; keys gc$v Enter; done
for v in $OLD $NEW; do waitfor gc$v 'Do you want to proceed\?' 20 && keys gc$v Down Enter; done; sleep 4; capb gc 132-danger-fast
for v in $OLD $NEW; do kill1 gc$v; done

# D. MCP approval (AgEnD never answers it): an Enter the moment it shows, then one more 3 s later.
sD() { fresh gd$1 $1; mkdir -p $A/w/gd$1; printf '{"mcpServers":{"probe":{"command":"/bin/true"}}}\n' > $A/w/gd$1/.mcp.json; WITHKEY=1 start gd$1 2.1.$1 $A/h/gd$1 $A/w/gd$1; }
both sD; sleep 1; for v in $OLD $NEW; do trust gd$v; done
for v in $OLD $NEW; do waitfor gd$v 'New MCP server found' 15 && keys gd$v Enter; done; sleep 3; capb gd 133-mcp-enter-fast
for v in $OLD $NEW; do keys gd$v Enter; done; sleep 3; capb gd 134-mcp-enter-again
for v in $OLD $NEW; do kill1 gd$v; done

