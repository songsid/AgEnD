# Isolated Claude Code TUI driver. Private tmux socket only; never the live server.
# AUDIT_DIR: a scratch directory holding the two binaries, named 2.1.292 and 2.1.294 (cap/, h/, inst/, w/ are made in it).
A=${AUDIT_DIR:?set AUDIT_DIR to the audit scratch directory}
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO=$(cd "$HERE/../../.." && pwd)
mkdir -p "$A/cap" "$A/h" "$A/inst" "$A/w"
SOCK=cc294audit
PORT=${PORT:-18294}
# A fake key of the right shape, built at run time so no secret-shaped literal is committed; the mock never checks it.
KEY="sk-ant-api03-$(printf 'test%.0s' $(seq 22))-testtestAA"
t() { env -u TMUX tmux -L $SOCK "$@"; }
# start <name> <ver> <home> <cwd> [args...]  — env: WITHKEY=1 to pass the API key
start() {
  local name=$1 ver=$2 home=$3 cwd=$4; shift 4
  mkdir -p "$home" "$cwd"
  local envs="HOME=$home CLAUDE_CONFIG_DIR=$home/.claude XDG_CONFIG_HOME=$home/.config XDG_DATA_HOME=$home/.local/share XDG_CACHE_HOME=$home/.cache XDG_STATE_HOME=$home/.local/state DISABLE_AUTOUPDATER=1 CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 DISABLE_TELEMETRY=1 DISABLE_ERROR_REPORTING=1 ANTHROPIC_BASE_URL=http://127.0.0.1:$PORT TERM=xterm-256color"
  [ -n "$WITHKEY" ] && envs="$envs ANTHROPIC_API_KEY=$KEY"
  t new-session -d -s "$name" -x 160 -y 50 -c "$cwd" "env -i PATH=/usr/bin:/bin $envs $A/$ver $* ; echo EXITED rc=\$?; sleep 3600"
}
cap() { t capture-pane -p -t "$1"; }
keys() { local n=$1; shift; t send-keys -t "$n" "$@"; }
paste() { local n=$1; shift; printf '%s' "$*" | t load-buffer -b p -; t paste-buffer -p -b p -t "$n"; }
kill1() { t kill-session -t "$1" 2>/dev/null; }
# step <prefix> <label> <sleep> <keys...>: send keys to <prefix>289 and <prefix>291, capture both, diff
step() {
  local p=$1 label=$2 s=$3; shift 3
  for v in 292 294; do [ $# -gt 0 ] && keys $p$v "$@"; done; sleep $s
  for v in 292 294; do cap $p$v | sed 's/[[:space:]]*$//' > $A/cap/$v-$label.txt; done
  if diff <(norm $A/cap/292-$label.txt) <(norm $A/cap/294-$label.txt) > $A/cap/diff-$label.txt; then echo "[$label] SAME"; else echo "[$label] DIFF ($(wc -l < $A/cap/diff-$label.txt) lines)"; fi
}
show() { sed '/^\s*$/d' $A/cap/294-$1.txt | grep -v "^[ .*░▓█▄]*$" | head -${2:-40}; }
norm() { sed -E 's/v2\.1\.29(2|4)/vX/g; s/([a-z])(292|294)/\1VV/g; s/(code_challenge|state)=[^&]*/\1=X/g' "$1"; }
# startcmd <name> <home> <cwd> <cmd-file>: run a production command line in the isolated env
startcmd() {
  local name=$1 home=$2 cwd=$3 cmdf=$4
  local envs="HOME=$home CLAUDE_CONFIG_DIR=$home/.claude XDG_CONFIG_HOME=$home/.config XDG_DATA_HOME=$home/.local/share XDG_CACHE_HOME=$home/.cache XDG_STATE_HOME=$home/.local/state DISABLE_AUTOUPDATER=1 CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 DISABLE_TELEMETRY=1 DISABLE_ERROR_REPORTING=1 TERM=xterm-256color PATH=$(dirname $(which node)):/usr/bin:/bin"
  t new-session -d -s "$name" -x 160 -y 50 -c "$cwd" "env -i $envs bash -c '$(cat $cmdf)'; echo EXITED rc=\$?; sleep 3600"
}
gencmd() { # gencmd <v> <prefix> [resume]
  local v=$1 p=$2 H=$A/h/ky$1
  (cd $REPO && HOME=$H CLAUDE_CONFIG_DIR=$H/.claude ANTHROPIC_API_KEY=$KEY ANTHROPIC_BASE_URL=http://127.0.0.1:$PORT npx tsx $HERE/gen-cmd.ts $A/inst/$p$v $A/w/$p$v $A/2.1.$v $3 2>/dev/null > $A/cmd-$p$v.txt)
}
# frames <prefix> <label> <count> <interval>: capture both versions repeatedly into cap/frames/<label>/<v>/NNN.txt
frames() {
  local p=$1 label=$2 n=$3 iv=$4
  for v in 292 294; do mkdir -p $A/cap/frames/$label/$v; done
  for i in $(seq -w 1 $n); do for v in 292 294; do cap $p$v > $A/cap/frames/$label/$v/$i.txt; done; sleep $iv; done
}
