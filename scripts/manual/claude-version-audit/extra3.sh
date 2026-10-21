# 2.1.306 audit, fourth pass: AgEnD's keys sent the moment a dialog appears.
# 2.1.305 "Improved MCP consent dialogs so an Enter meant for the prompt is less likely to be taken as Accept". This pass
# checks that no such guard swallows the keys AgEnD sends to the dialogs it answers (trust, bypass, dangerous-command), and
# records what an immediate Enter does on the MCP approval (which AgEnD never answers).
# Run after extra.sh (it reuses pass1's k homes, like extra.sh). Same rig: private tmux socket, isolated HOMEs, local mock.
set -u; . "$(dirname "$0")/lib.sh"
fresh() { rm -rf "${A:?}/h/$1"; cp -a "$A/h/k$2" "$A/h/$1"; }
capb() { for v in $OLD $NEW; do cap $1$v | sed 's/[[:space:]]*$//' > $A/cap/$v-$2.txt; done
  if diff <(norm $A/cap/$OLD-$2.txt) <(norm $A/cap/$NEW-$2.txt) > $A/cap/diff-$2.txt; then echo "[$2] SAME"; else echo "[$2] DIFF ($(wc -l < $A/cap/diff-$2.txt) lines)"; fi; }
both() { for v in $OLD $NEW; do "$@" $v; done; }
# waitfor <session> <regex> <timeout-s>: poll every 0.1 s until the pane matches; prints the time it took (or TIMEOUT)
waitfor() { local s=$1 re=$2 n=$(( $3 * 10 )) i=0; while [ $i -lt $n ]; do cap $s | grep -qE "$re" && { echo "$s ready after $((i * 100)) ms"; return 0; }; sleep 0.1; i=$((i + 1)); done; echo "$s TIMEOUT waiting for $re"; return 1; }

# A. workspace trust: AgEnD sends Down, then Enter — here at once, the moment the dialog shows.
sA() { fresh fa$1 $1; mkdir -p $A/w/fa$1; WITHKEY=1 start fa$1 2.1.$1 $A/h/fa$1 $A/w/fa$1; }
both sA; for v in $OLD $NEW; do waitfor fa$v 'trust this folder' 15 && keys fa$v Down Enter; done; sleep 4; capb fa 120-trust-fast
for v in $OLD $NEW; do kill1 fa$v; done

# B. Bypass Permissions warning: trust first (as in extra.sh), then Down, Enter at once when the warning shows.
sB() { fresh fb$1 $1; WITHKEY=1 start fb$1 2.1.$1 $A/h/fb$1 $A/w/fb$1 --dangerously-skip-permissions; }
both sB; for v in $OLD $NEW; do waitfor fb$v 'trust this folder' 15 && keys fb$v Down Enter; done
for v in $OLD $NEW; do waitfor fb$v 'Bypass Permissions mode' 15 && keys fb$v Down Enter; done; sleep 4; capb fb 121-bypass-fast
for v in $OLD $NEW; do kill1 fb$v; done

# C. dangerous rm under bypass: Down, Enter (select No) at once when the prompt shows.
sC() { fresh fc$1 $1; printf '{\n  "theme": "dark",\n  "skipDangerousModePermissionPrompt": true\n}\n' > $A/h/fc$1/.claude/settings.json; WITHKEY=1 start fc$1 2.1.$1 $A/h/fc$1 $A/w/fc$1 --dangerously-skip-permissions; }
both sC; for v in $OLD $NEW; do waitfor fc$v 'trust this folder' 15 && keys fc$v Down Enter; done; sleep 3
for v in $OLD $NEW; do paste fc$v "DANGER go"; sleep 1; keys fc$v Enter; done
for v in $OLD $NEW; do waitfor fc$v 'Do you want to proceed\?' 20 && keys fc$v Down Enter; done; sleep 4; capb fc 122-danger-fast
for v in $OLD $NEW; do kill1 fc$v; done

# D. MCP approval (AgEnD never answers it): what an immediate Enter does, and one sent 2 s later.
sD() { fresh fd$1 $1; mkdir -p $A/w/fd$1; printf '{"mcpServers":{"probe":{"command":"/bin/true"}}}\n' > $A/w/fd$1/.mcp.json; WITHKEY=1 start fd$1 2.1.$1 $A/h/fd$1 $A/w/fd$1; }
both sD; for v in $OLD $NEW; do waitfor fd$v 'trust this folder' 15 && keys fd$v Down Enter; done
for v in $OLD $NEW; do waitfor fd$v 'MCP server' 15 && keys fd$v Enter; done; sleep 3; capb fd 123-mcp-enter-fast
for v in $OLD $NEW; do keys fd$v Enter; done; sleep 3; capb fd 124-mcp-enter-again
for v in $OLD $NEW; do kill1 fd$v; done
