# lib.sh: k234 rig helpers (private tmux socket k234 only; scratch HOMEs; unshare -rn via kenv).
K=${K:?set K to the rig dir}; T="tmux -L k234"
init_home() { # init_home <ver> <home>: first run creates data.sqlite3 at the sign-in screen; Esc; seed a dummy token
  local v=$1 h=$2; rm -rf $h; mkdir -p $h
  $T new-session -d -s init -x 120 -y 40 "$K/bin/kenv $v $h kiro-cli chat --legacy-ui --agent-engine=v1"; sleep 10
  $T send-keys -t init Escape; sleep 2; $T kill-session -t init 2>/dev/null
  python3 -I $K/bin/seed.py $h/.local/share/kiro-cli/data.sqlite3 >/dev/null; }
work() { # work <dir>: a git repo with an AgEnD-shaped AGENTS.md
  rm -rf $1; mkdir -p $1; (cd $1 && git init -q && printf '# audit\n' > AGENTS.md && git add -A && git -c user.email=a@b -c user.name=a commit -qm init); }
launch() { # launch <session> <ver> <home> <cwd> <width> <args…>
  local s=$1 v=$2 h=$3 c=$4 w=$5; shift 5
  $T kill-session -t $s 2>/dev/null; $T new-session -d -s $s -x $w -y 40 -c $c "$K/bin/kenv $v $h kiro-cli chat $*"
  $T set-option -t $s remain-on-exit on >/dev/null; }
cap() { $T capture-pane -p -t "$1" > "$K/out/$2.pane.txt"; $T capture-pane -p -e -t "$1" > "$K/out/$2.pane-e.txt"; }
mlaunch() { # mlaunch <session> <ver> <home> <cwd> <mockfile|-> <args…>: launch with KIRO_MOCK_CHAT_RESPONSE
  local s=$1 v=$2 h=$3 c=$4 m=$5; shift 5
  $T kill-session -t $s 2>/dev/null; $T new-session -d -s $s -x 120 -y 40 -c $c "KIRO_MOCK_CHAT_RESPONSE=$([ "$m" = - ] || echo $m) $K/bin/kenv $v $h kiro-cli chat $*"
  $T set-option -t $s remain-on-exit on >/dev/null; }
drive() { (cd $K/../rb && KV=$2 TREE=$K/../rb K=$K timeout 70 npx tsx $K/drive.mts $1 $K/out/drv-$1 2>&1 | tail -1); }
say() { $T send-keys -t $1 -l "$2"; sleep 0.7; $T send-keys -t $1 Enter; }
SOCK=${SOCK:-/tmp/k234.sock}   # a short path: a unix socket path is limited to 108 bytes
molaunch() { # molaunch <session> <ver> <home> <cwd> <width> <args…>: the TUI on its mock ACP agent + the test IPC socket
  local s=$1 v=$2 h=$3 c=$4 w=$5; shift 5
  pkill -f "k234/bin/[i]pc.mjs" ; sleep 0.5; I=$K/ipc-$s; rm -rf $I; mkdir -p $I; rm -f $SOCK; (node $K/bin/ipc.mjs $SOCK $I > $I/ipc.out 2>&1 &); sleep 1
  mkdir -p $h/.kiro/settings; echo '{"enabled":false}' > $h/.kiro/settings/sandbox.json
  $T kill-session -t $s 2>/dev/null; $T new-session -d -s $s -x $w -y 40 -c $c "KIRO_MOCK_ACP=true KIRO_TEST_MODE=1 KIRO_TEST_TUI_IPC_SOCKET_PATH=$SOCK KIRO_TEST_MOCK_TURN_TIMEOUT_MS=900000 $K/bin/kenv $v $h kiro-cli chat $*"
  $T set-option -t $s remain-on-exit on >/dev/null; }
cmd() { echo "$2" > $K/ipc-$1/cmd-$(date +%s%N).json; }
