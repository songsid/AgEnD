#!/usr/bin/env bash
# One local mock turn on NEW, then production exact-session resume on OLD using the same owned home.
# Run inside a loopback-only namespace; AUDIT contains both scratch installs. No account is used.
set -euo pipefail
NEW="${1:?new version}"; OLD="${2:?old version}"
HERE="$(cd "$(dirname "$0")" && pwd)"; REPO="$(cd "$HERE/../../.." && pwd)"; R="$HERE/rig.sh"
: "${AUDIT:?set AUDIT}"; export WIN=rollback
r() { bash "$R" "$NEW" "$@"; }
for item in $(r paths); do
  case "$item" in SOCK=*) SOCK="${item#SOCK=}";; AH=*) AH="${item#AH=}";; SH=*) SH="${item#SH=}";; RUN=*) RUN="${item#RUN=}";; esac
done
T() { tmux -f /dev/null -L "$SOCK" "$@"; }
trap 'r stop' EXIT
r mock; r mode ok
r launch rollback fresh trust '' 150x45 work
r cap new-launch 3
r send 'audit rollback checkpoint'
r cap new-turn 4
# End only this owned pane before opening the same session with the prior binary.
r key C-c; sleep 0.5; r key C-c
r cap new-quit 2
T kill-session -t "$WIN" 2>/dev/null || true
BIN="$AUDIT/codex-$OLD/node_modules/.bin"
command="$(cd "$REPO" && PATH="$BIN:$PATH" AGEND_HOME="$AH" CODEX_HOME="$SH" \
  "$REPO/node_modules/.bin/tsx" "$HERE/gen-cmd.ts" "$RUN/inst-rollback" "$RUN/work" "${PORT:-18762}" resume trust)"
printf '%s\n' "$command" > "$RUN/cmd-rollback-old.txt"
case "$command" in *' resume '*) ;; *) echo 'No exact-session resume command' >&2; exit 1;; esac
T new-session -d -s "$WIN" -x 150 -y 45 -c "$RUN/work" "PATH=$BIN:\$PATH AGEND_HOME=$AH $command; sleep 600"
r cap old-resume 5
T capture-pane -p -t "$WIN" > "$RUN/old-resume-final.txt"
grep -q "OpenAI Codex (v$OLD)" "$RUN/old-resume-final.txt"
grep -q 'audit rollback checkpoint' "$RUN/old-resume-final.txt"
grep -q 'Ask Codex to do anything' "$RUN/old-resume-final.txt"
CLASSIFY_INST="$RUN/inst-rollback" AGEND_HOME="$AH" CODEX_HOME="$SH" \
  "$REPO/node_modules/.bin/tsx" "$HERE/classify.ts" each "$RUN/old-resume-final.txt" > "$RUN/rollback-reading.txt"
grep -q 'ready idle deliver-ok' "$RUN/rollback-reading.txt"
