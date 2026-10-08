#!/usr/bin/env bash
# codex version audit rig. Usage: rig.sh <VERSION> <step> [args]
#   VERSION     codex version installed under $AUDIT/codex-$VERSION (npm --prefix), never the host install
#   steps       mock | launch <name> [resume|fresh] [trust|untrusted] [nudge] [WxH] [workdir-name] | clone <name> <from>
#               | raw <name> <inst> <workdir-name> <codex args…> | cap <scenario> <secs>
#               | send <text> | key <tmux-key> | mode <ok|slow|near|usage|e401|e500|capacity> | kill | stop
# Env: AUDIT (scratch root, required), PORT (default 18762), WIN (tmux window target, default "a").
# Homes are short paths under $HOME (codex refuses helper binaries under /tmp and its socket path must fit SUN_LEN);
# the private tmux socket is cx<version-digits>audit. Nothing here touches ~/.codex or the live tmux server.
set -euo pipefail
V="${1:?version}"; STEP="${2:?step}"; shift 2
: "${AUDIT:?set AUDIT to the scratch root}"
TAG="${V//./}"; PORT="${PORT:-18762}"; SOCK="cx${TAG}audit"; WIN="${WIN:-a}"
AH="$HOME/.cxa$TAG"; SH="$HOME/.cxs$TAG"; RUN="$AUDIT/run-$TAG"; BIN="$AUDIT/codex-$V/node_modules/.bin"
HERE="$(cd "$(dirname "$0")" && pwd)"; REPO="$(cd "$HERE/../../.." && pwd)"
mkdir -p "$RUN/cap"
T() { tmux -L "$SOCK" "$@"; }
case "$STEP" in
  mock)
    echo ok > "$RUN/mode"
    T has-session -t mock 2>/dev/null || T new-session -d -s mock -x 120 -y 20 \
      "PORT=$PORT MOCK_MODE_FILE=$RUN/mode MOCK_LOG=$RUN/mock.log exec node $HERE/mock.mjs"
    ;;
  launch)
    NAME="${1:?name}"; RES="${2:-fresh}"; TR="${3:-trust}"; NUDGE="${4:-}"; SIZE="${5:-150x45}"; WD="${6:-work}"
    W="$RUN/$WD"; mkdir -p "$W"; [ -d "$W/.git" ] || git -C "$W" init -q
    CMD="$(cd "$REPO" && PATH="$BIN:$PATH" AGEND_HOME="$AH" CODEX_HOME="$SH" npx tsx "$HERE/gen-cmd.ts" "$RUN/inst-$NAME" "$W" "$PORT" "$RES" "$TR" "$NUDGE")"
    echo "$CMD" > "$RUN/cmd-$NAME.txt"
    T kill-session -t "$NAME" 2>/dev/null || true
    T new-session -d -s "$NAME" -x "${SIZE%x*}" -y "${SIZE#*x}" -c "$W" "PATH=$BIN:\$PATH AGEND_HOME=$AH $CMD; sleep 600"
    ;;
  clone)
    # a second codex on the SAME launch command as <from> (same home, same thread) → the thread-writer lock screen
    NAME="${1:?name}"; FROM="${2:?from}"; SIZE="${3:-150x45}"; CMD="$(cat "$RUN/cmd-$FROM.txt")"
    T kill-session -t "$NAME" 2>/dev/null || true
    T new-session -d -s "$NAME" -x "${SIZE%x*}" -y "${SIZE#*x}" -c "$RUN/work" "PATH=$BIN:\$PATH AGEND_HOME=$AH $CMD; sleep 600"
    ;;
  raw)
    # an arbitrary codex command line in the instance home of <inst> (e.g. `resume --last` for the cwd picker)
    NAME="${1:?name}"; INST="${2:?inst}"; WD="${3:?workdir-name}"; shift 3
    HOMEDIR="$(sed -n "s/^CODEX_HOME='\([^']*\)'.*/\1/p" "$RUN/cmd-$INST.txt")"
    T kill-session -t "$NAME" 2>/dev/null || true
    T new-session -d -s "$NAME" -x 150 -y 45 -c "$RUN/$WD" "PATH=$BIN:\$PATH AGEND_HOME=$AH CODEX_HOME=$HOMEDIR $BIN/codex $*; sleep 600"
    ;;
  cap)
    SC="${1:?scenario}"; SECS="${2:?secs}"; D="$RUN/cap/$SC"; mkdir -p "$D"
    end=$(( $(date +%s%N) + SECS * 1000000000 )); n=0; prev=""
    while [ "$(date +%s%N)" -lt "$end" ]; do
      cur="$(T capture-pane -p -t "$WIN" 2>/dev/null || true)"
      if [ "$cur" != "$prev" ]; then n=$((n + 1)); printf '%s\n' "$cur" > "$D/$(printf '%05d' "$n")-$(( ($(date +%s%N) - end + SECS * 1000000000) / 1000000 ))ms.txt"; prev="$cur"; fi
      sleep 0.025
    done
    echo "$SC: $n distinct frames"
    ;;
  send) T send-keys -t "$WIN" -l "${1:?text}"; sleep 0.3; T send-keys -t "$WIN" Enter ;;
  key) T send-keys -t "$WIN" "${1:?key}" ;;
  mode) echo "${1:?mode}" > "$RUN/mode" ;;
  kill)
    # kill this version's app-server daemon (its environ carries CODEX_HOME under $AH) → the reconnect panes
    for p in $(pgrep -f "app-server" || true); do
      if tr '\0' '\n' < "/proc/$p/environ" 2>/dev/null | grep -q "^CODEX_HOME=$AH/"; then echo "kill $p"; kill "$p"; fi
    done
    ;;
  stop) T kill-server 2>/dev/null || true ;;
  *) echo "unknown step $STEP" >&2; exit 2 ;;
esac
