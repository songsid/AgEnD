#!/bin/sh
# Smoke-run one built bundled tmux on its own runner (M-2457 §3): the version, a private-socket server that starts,
# answers, captures a CJK + emoji line at the widths the CLIs assume, and is killed — its end proved, not assumed.
# Never the default socket. The panes run fixed programs in argv form (tmux execs them directly: no login shell, no
# startup files), with SHELL=/bin/sh and no ENV/BASH_ENV.
#   scripts/tmux/smoke-tmux.sh <dir holding bin/tmux and share/terminfo> <expected version, e.g. 3.8>
set -eu
DIR=${1:?bundle dir}; WANT=${2:?expected tmux version}
T="$DIR/bin/tmux"
# A UTF-8 locale the host has: macOS names it en_US.UTF-8, Linux (glibc and musl) C.UTF-8.
case "$(uname -s)" in Darwin) LOC=en_US.UTF-8 ;; *) LOC=C.UTF-8 ;; esac
export TERMINFO_DIRS="$DIR/share/terminfo" LANG=$LOC LC_ALL=$LOC SHELL=/bin/sh
unset ENV BASH_ENV TMUX TMUX_PANE 2>/dev/null || true
SOCK="agend-smoke-$$"
SERVER_PID=""
# SMOKE_VERBOSE=1 (CI): the server logs (-vv: tmux-server-<pid>.log in a scratch dir), shown on a failure with any
# macOS crash report — a server that dies at once says why (darwin-x64, run 42268291999).
V=""; LOGDIR=""
if [ "${SMOKE_VERBOSE:-}" = 1 ]; then V="-vv"; LOGDIR=$(mktemp -d "${TMPDIR:-/tmp}/tmux-smoke-log.XXXXXX"); fi
diagnose() {
  [ -n "$LOGDIR" ] || return 0
  for f in "$LOGDIR"/tmux-*.log; do [ -f "$f" ] && { echo "smoke: --- $f (last 60 lines)" >&2; tail -n 60 "$f" >&2; }; done
  if [ "$(uname -s)" = Darwin ]; then
    for f in $(ls -t "$HOME/Library/Logs/DiagnosticReports"/tmux* 2>/dev/null | head -n 1); do
      echo "smoke: --- crash report $f" >&2; head -n 80 "$f" >&2
    done
  fi
}
fail() {
  echo "smoke: $*" >&2
  diagnose
  "$T" -L "$SOCK" kill-server >/dev/null 2>&1 || true
  [ -z "$SERVER_PID" ] || echo "smoke: server pid $SERVER_PID, socket -L $SOCK left in place" >&2
  exit 1
}
# Positive evidence that a process has exited: no such process, or a zombie (exited, not reaped yet).
gone() { ! kill -0 "$1" 2>/dev/null || ps -o stat= -p "$1" 2>/dev/null | grep -q '^ *Z'; }

got=$("$T" -L "$SOCK" -V) || fail "tmux -V failed"
[ "$got" = "tmux $WANT" ] || fail "tmux -V says '$got', not 'tmux $WANT'"

# 中文 = 2 + 2 cells, then 🫨 (Unicode 15) = 2 — utf8proc's tables; musl's wcwidth says 1 — then "ok": column 8.
if [ -n "$LOGDIR" ]; then
  (cd "$LOGDIR" && "$T" -L "$SOCK" $V -f /dev/null new-session -d -s s -x 40 -y 5 /bin/sh -c "printf '中文🫨ok'; exec sleep 60") \
    || fail "the server did not start on a private socket"
else
  "$T" -L "$SOCK" -f /dev/null new-session -d -s s -x 40 -y 5 /bin/sh -c "printf '中文🫨ok'; exec sleep 60" \
    || fail "the server did not start on a private socket"
fi
SERVER_PID=$("$T" -L "$SOCK" display-message -p -t s '#{pid}') || fail "display-message"
SOCKET_PATH=$("$T" -L "$SOCK" display-message -p -t s '#{socket_path}') || fail "display-message socket_path"
# The socket's identity while its server is up: only this inode is removed after the proved exit.
[ "$(basename "$SOCKET_PATH")" = "$SOCK" ] && [ -S "$SOCKET_PATH" ] || fail "the server's socket '$SOCKET_PATH' is not this run's"
# Identity = inode + change time to the nanosecond: an inode number alone can be reused at once by a file created
# where a removed one was.
inode() { case "$(uname -s)" in Darwin) stat -f '%i %Fc' "$1" 2>/dev/null ;; *) stat -c '%i %z' "$1" 2>/dev/null ;; esac; }
SOCKET_INO=$(inode "$SOCKET_PATH")
[ -n "$SOCKET_INO" ] || fail "the server's socket has no inode"
case "$SERVER_PID" in ''|*[!0-9]*) fail "the server did not say its pid ('$SERVER_PID')" ;; esac
"$T" -L "$SOCK" has-session -t s || fail "has-session"
i=0; line=""
while [ $i -lt 50 ]; do
  line=$("$T" -L "$SOCK" capture-pane -p -t s | head -n 1) || fail "capture-pane"
  case "$line" in *ok*) break ;; esac
  i=$((i + 1)); sleep 0.1
done
case "$line" in 中文🫨ok*) ;; *) fail "capture-pane read '$line'" ;; esac
x=$("$T" -L "$SOCK" display-message -p -t s '#{cursor_x}') || fail "display-message cursor_x"
[ "$x" = "8" ] || fail "the line is $x cells wide, not 8 (CJK/emoji width)"

"$T" -L "$SOCK" kill-server || fail "kill-server"
i=0
until gone "$SERVER_PID"; do
  i=$((i + 1)); [ $i -lt 100 ] || fail "the server (pid $SERVER_PID) is still running after kill-server"; sleep 0.05
done
# The socket answers a clean "no server" (exit 1); anything else (a hang, a signal, another code) is not proof.
set +e; "$T" -L "$SOCK" has-session >/dev/null 2>&1; rc=$?; set -e
[ "$rc" = 1 ] || fail "whether the server ended could not be confirmed (has-session exit $rc)"
# tmux leaves its socket file behind: remove this run's — the same inode — now that its server is proved gone. A file
# that replaced it at that path is someone else's and stays.
if [ -S "$SOCKET_PATH" ] && [ "$(inode "$SOCKET_PATH")" = "$SOCKET_INO" ]; then rm -f "$SOCKET_PATH"; fi
echo "smoke ok: tmux $WANT, private socket, CJK/emoji width 8, server pid $SERVER_PID gone"
