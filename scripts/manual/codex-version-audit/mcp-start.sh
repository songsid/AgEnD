#!/usr/bin/env bash
# M-3653: when does codex start an AgEnD-shaped stdio MCP server? Codex 0.172.0 added lazy stdio startup
# (mcp_lazy_stdio_startup, on by default), and AgEnD's daemon learns of an agent from its MCP server's mcp_ready.
# Launches through the production config with stub-mcp.mjs registered, then: a turn, another turn, quit, a production
# resume launch, a turn. (An in-place /model switch is not part of it: the mock lists no models, so codex refuses the
# switch and nothing in it is rebuilt.) The stub logs start/initialize/tools-list/exit to MARK, with a line per step.
# Fails (exit 1, after printing the log) when a rig step fails, the server did not start after a launch, or a turn did
# not reach codex — so a run that proves nothing never reads as a pass.
# Usage, inside netns.sh with the audited codex first on PATH:
#   AUDIT=… PORT=… MARK=<log file> netns.sh mcp-start.sh <VERSION>
# Tests only: RIG (the rig script), CAPTURE (prints the main pane), WAIT (seconds per step; default 10 after a launch, 6 after a turn).
set -uo pipefail
V="${1:?version}"; HERE="$(cd "$(dirname "$0")" && pwd)"; R="${RIG:-$HERE/rig.sh}"
: "${MARK:?set MARK}"; : > "$MARK"
export GEN_MCP="$HERE/stub-mcp.mjs" GEN_MCP_MARK="$MARK" WIN=main   # send, key and cap act on this window
failed=0
fail() { echo "--- FAILED: $1" >> "$MARK"; failed=1; }
r() { bash "$R" "$V" "$@" || { fail "rig $*"; return 1; }; }
step() { echo "--- $1 @ $(date +%s%3N)" >> "$MARK"; }
pause() { sleep "${WAIT:-$1}"; }
trap 'bash "$R" "$V" stop >/dev/null 2>&1 || true' EXIT
SOCK="$(bash "$R" "$V" paths | tr ' ' '\n' | sed -n 's/^SOCK=//p')"
pane() { if [ -n "${CAPTURE:-}" ]; then bash -c "$CAPTURE"; else tmux -f /dev/null -L "$SOCK" capture-pane -p -S - -t main; fi; }
# Each turn must reach codex, or the log says nothing about it: checked on the pane right after.
# The pane is read whole first: `pane | grep -q` under pipefail failed when grep's early exit sent SIGPIPE to the
# pane's writer (exit 141), so a turn that was on the pane read as NOT reached (#4421 CI, a different PR's run).
reached() { local p; p="$(pane 2>/dev/null)" || p=""; if grep -qF -- "$1" <<<"$p"; then echo "--- reached: $1" >> "$MARK"; else echo "--- NOT reached: $1" >> "$MARK"; failed=1; fi; }
# The server must have started after this launch's step line, and before its first turn.
started() { awk -v s="--- $1 @" 'index($0, s) == 1 { on = 1; next } on && /^--- / { exit } on && / start$/ { ok = 1 } END { exit !ok }' "$MARK" \
  || fail "the MCP server did not start after $1"; }
r mock
step launch-fresh;  r launch main fresh trust; pause 10;                          started launch-fresh
step turn;          r mode ok; r send "hello"; pause 6;                            reached "hello"
step turn2;         r send "again"; pause 6;                                       reached "again"
step quit;          r key C-c; sleep 0.5; r key C-c; pause 3
step launch-resume; r launch main resume trust; pause 10;                          started launch-resume
step turn3;         r send "after resume"; pause 6;                                reached "after resume"
cat "$MARK"
[ "$failed" = 0 ] && echo "mcp-start: PASS" || { echo "mcp-start: FAIL" >&2; exit 1; }
