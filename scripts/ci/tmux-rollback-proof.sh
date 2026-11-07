#!/usr/bin/env bash
# M-2457 §7 rollback proof (ephemeral CI, docs/design/bundled-tmux.md): the candidate, with AgEnD's own tmux server on
# its private socket (as the fleet starts and records it), then `agend rollback <2.3.x>`:
#   leg F (failed close): the private server is SIGSTOPped, so it cannot be ended — the rollback must stop before npm
#                         runs: still the candidate installed, no rollback.json;
#   leg R (rollback):     the server is ended by its recorded client and confirmed (no server on the socket, its pane
#                         process exited), rollback.json written, then the published 2.3.x installed.
# Isolation: a private prefix, HOME, AGEND_HOME and TMUX_TMPDIR (so the private socket is under the work dir, never a
# live server); systemctl/launchctl/sudo are stubs that log and fail, so `agend stop` reaches no service manager.
# Usage: tmux-rollback-proof.sh <baseline 2.3.x tarball> <candidate tarball> <baseline version>
set -euo pipefail
BASELINE_TGZ="$(realpath "${1:?verified previous-release tarball}")"
CANDIDATE_TGZ="$(realpath "${2:?candidate tarball}")"
BASELINE_VERSION="${3:?previous-release version}"
[[ "$BASELINE_VERSION" =~ ^2\.3\.[0-9]+$ ]] || { echo 'Expected a 2.3.x rollback target' >&2; exit 1; }
TMUX_BIN=""   # the candidate's bundled tmux, once installed (its verified copy under AGEND_HOME, as the fleet runs it)
WORK=$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/agend-tmux-rollback.XXXXXX")
PREFIX="$WORK/prefix"
mkdir -p "$PREFIX" "$WORK/home" "$WORK/agend" "$WORK/tmux" "$WORK/guard"
export HOME="$WORK/home" XDG_CONFIG_HOME="$WORK/home/.config" AGEND_HOME="$WORK/agend" TMUX_TMPDIR="$WORK/tmux"
export npm_config_prefix="$PREFIX" npm_config_cache="$WORK/cache" npm_config_userconfig="$WORK/npmrc"
: > "$npm_config_userconfig"
for tool in systemctl launchctl sudo; do printf '#!/bin/sh\necho "%s $*" >> "%s/guard.log"\nexit 1\n' "$tool" "$WORK" > "$WORK/guard/$tool"; chmod +x "$WORK/guard/$tool"; done
export PATH="$WORK/guard:$PREFIX/bin:$PATH"
unset TMUX TMUX_PANE
cleanup() { [ -n "${SOCK:-}" ] && [ -n "$TMUX_BIN" ] && "$TMUX_BIN" -L "$SOCK" kill-server 2>/dev/null || true; pkill -CONT -f "$WORK" 2>/dev/null || true; rm -rf "${WORK:?}"; }
trap cleanup EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }
installed() { node -p 'require(process.argv[1]).version' "$PREFIX/lib/node_modules/@songsid/agend/package.json"; }

CANDIDATE_VERSION=$(tar -xOf "$CANDIDATE_TGZ" package/package.json | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).version')
npm install --global "$CANDIDATE_TGZ" --registry https://registry.npmjs.org/ >/dev/null
[ "$(installed)" = "$CANDIDATE_VERSION" ] || fail "the candidate did not install"
PKG="$PREFIX/lib/node_modules/@songsid/agend"
# The bundled tmux this candidate pins (an optional dependency, verified by its postinstall): no system tmux involved.
TMUX_BIN=$(node -e 'import(process.argv[1]).then(m => process.stdout.write(m.tmuxBinary()))' "$PKG/dist/tmux-binary.js")
[ -x "$TMUX_BIN" ] || fail "the candidate's bundled tmux did not resolve"
export TMUX_BIN

# This home's socket, as AgEnD names it (an isolated AGEND_HOME gets its own hashed name; the real home's is `agend`).
SOCK=$(node -e 'import(process.argv[1]).then(m => process.stdout.write(m.tmuxSocket()))' "$PKG/dist/tmux-binary.js")
[ -n "$SOCK" ] || fail "no socket name"
# AgEnD's server as the fleet starts it (agend tmux = -L <socket> -f agend-tmux.conf), recorded as the fleet records it.
start_server() {
  agend tmux new-session -d -s agend -n dev "sleep 600"
  node -e '
    import(process.argv[1]).then(async m => {
      const r = await m.recordServer({ agendHome: process.env.AGEND_HOME, socket: process.argv[2], version: "",
        current: { binary: process.env.TMUX_BIN, sha256: m.sha256File(process.env.TMUX_BIN) } });
      if (!r) process.exit(1);
    });' "$PKG/dist/tmux-server.js" "$SOCK"
  SERVER_PID=$(node -p 'require(process.argv[1]).serverPid' "$AGEND_HOME/tmux/server.json")
  PANE_PID=$(agend tmux list-panes -a -F '#{pane_pid}')
  kill -0 "$SERVER_PID" && kill -0 "$PANE_PID" || fail "the private server did not start"
}

echo "── leg F: a server that cannot be ended stops the rollback before npm"
start_server
kill -STOP "$SERVER_PID"
set +e; OUT=$(agend rollback "$BASELINE_VERSION" --package "$BASELINE_TGZ" --no-start --yes 2>&1); CODE=$?; set -e
echo "$OUT"
kill -CONT "$SERVER_PID"
[ "$CODE" -ne 0 ] || fail "the rollback went on past an unconfirmed close"
grep -q "Rollback stopped before installing anything" <<<"$OUT" || fail "no stop message"
[ "$(installed)" = "$CANDIDATE_VERSION" ] || fail "npm ran after a failed close"
[ ! -e "$AGEND_HOME/rollback.json" ] || fail "rollback.json written after a failed close"
"$TMUX_BIN" -L "$SOCK" kill-server 2>/dev/null || true
for _ in $(seq 50); do kill -0 "$SERVER_PID" 2>/dev/null || break; sleep 0.1; done

echo "── leg R: the private server closed (confirmed), then $BASELINE_VERSION installed"
start_server
agend rollback "$BASELINE_VERSION" --package "$BASELINE_TGZ" --no-start --yes
! "$TMUX_BIN" -L "$SOCK" list-sessions 2>/dev/null || fail "a server is still on -L $SOCK"
! kill -0 "$SERVER_PID" 2>/dev/null || fail "the private server ($SERVER_PID) is still running"
! kill -0 "$PANE_PID" 2>/dev/null || fail "its agent process ($PANE_PID) is still running"
[ -f "$AGEND_HOME/rollback.json" ] || fail "no rollback.json"
[ "$(installed)" = "$BASELINE_VERSION" ] || fail "$BASELINE_VERSION is not installed"
[ "$(agend --version)" = "$BASELINE_VERSION" ] || fail "agend --version is not $BASELINE_VERSION"
[ ! -s "$WORK/guard.log" ] || { cat "$WORK/guard.log"; fail "a service manager was called"; }
echo "Rollback proof: $CANDIDATE_VERSION (bundled tmux on) -> $BASELINE_VERSION, the private server closed and confirmed first"
