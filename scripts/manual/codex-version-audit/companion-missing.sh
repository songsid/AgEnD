#!/usr/bin/env bash
# The codex companion repro (codex-code-mode-host missing next to bin/codex). Usage:
#   companion-missing.sh <package-dir> <label> [mode]
#   package-dir  an official package layout: the directory holding codex-package.json and bin/codex (for the npm
#                platform tarball, package/vendor/<triple>), unpacked in scratch; never the host's ~/.codex install
#   label        names this run's socket, homes and output (short: it is part of paths under $HOME)
#   mode         the mock's turn: toolexec (default; the code-mode exec tool), tool (AgEnD's MCP reply), toolshell
# AgEnD's production writeConfig + buildCommand (gen-cmd.ts) launches codex in a private tmux server started inside an
# unshare -rn network namespace (loopback only), with scratch AGEND_HOME / CODEX_HOME under $HOME and the rig's mock as
# the Responses API. Code mode is switched on in the shared config ([features] code_mode, code_mode_host,
# code_mode_only), so every tool runs through the host, as on the incident host. Frames land in $OUT/<label>/.
# No account, no network, never ~/.codex or the live tmux server. Tear down with: tmux -S "$OUT/<label>.sock" kill-server
set -euo pipefail
PKG="$(cd "${1:?package dir}" && pwd -P)"; LABEL="${2:?label}"; MODE="${3:-toolexec}"
OUT="${OUT:-$HOME/.cxcm}"; PORT="${PORT:-18793}"
HERE="$(cd "$(dirname "$0")" && pwd)"; REPO="$(cd "$HERE/../../.." && pwd)"
RUN="$OUT/$LABEL"; SOCK="$OUT/$LABEL.sock"; AH="$OUT/$LABEL-a"; SH="$OUT/$LABEL-s"; BIN="$OUT/$LABEL-bin"
[ ! -e "$RUN" ] || { echo "$RUN exists: pick a new label or remove it" >&2; exit 1; }
mkdir -p "$RUN/cap" "$RUN/work" "$BIN"; git -C "$RUN/work" init -q
ln -s "$PKG/bin/codex" "$BIN/codex"
echo "$MODE" > "$RUN/mode"
CMD="$(cd "$REPO" && PATH="$BIN:$PATH" AGEND_HOME="$AH" CODEX_HOME="$SH" \
  GEN_EXTRA_TOML=$'[features]\ncode_mode = true\ncode_mode_host = true\ncode_mode_only = true' \
  npx tsx "$HERE/gen-cmd.ts" "$RUN/inst" "$RUN/work" "$PORT" fresh trust)"
echo "$CMD" > "$RUN/cmd.txt"
env -u TMUX unshare -rn sh -c "
  ip link set lo up
  tmux -S '$SOCK' new-session -d -s mock -x 120 -y 20 'PORT=$PORT MOCK_MODE_FILE=$RUN/mode MOCK_LOG=$RUN/mock.log BODY_LOG=$RUN/body.log exec node $HERE/mock.mjs'
  sleep 1
  tmux -S '$SOCK' new-session -d -s a -x 150 -y 45 -c '$RUN/work' 'PATH=$BIN:\$PATH AGEND_HOME=$AH $CMD; sleep 600'
"
echo "SOCK=$SOCK RUN=$RUN"
