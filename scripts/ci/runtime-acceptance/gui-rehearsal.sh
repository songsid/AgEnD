#!/usr/bin/env bash
# #1450 rehearsal in launchd's GUI domain, on a GitHub-hosted macOS runner (its runner user has a logged-in Aqua
# session, so gui/<uid> exists). Everything is the REAL thing — launchctl, the published 2.1.12 from npmjs on Node
# 20.19, its own `agend update` — except that the candidate and its runtime packages come from a local registry.
#   1. 2.1.12 + Node 20: `agend install` loads com.agend.fleet into gui/<uid>; the fleet answers /health.
#   2. 2.1.12's `agend update --version <candidate>` (npm, verification, service refresh, restart).
#   3. After it: the planned activation was consumed, launchd runs <bundled node> <pkg>/dist/cli.js fleet start (a new
#      pid, argv0 = the bundled Node), /health is 200, no bundled directory on the fleet's PATH, and an npm-installed
#      `#!/usr/bin/env node` CLI there runs on the system Node.
#   4. The restart guard: a plain `agend restart` is admitted (path 1); with AGEND_NODE in launchd's environment it is
#      refused and the running fleet is not touched.
# A runner without gui/<uid> fails this job — it never falls back to another domain or a stub.
# Usage: gui-rehearsal.sh <packages dir>   (after registry.sh; Node 20.19 on PATH; ephemeral runner only)
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
PKGS="${1:?packages dir}"
CAND="$(node -p 'require(process.argv[1]).version' "$PKGS/candidate.json")"
PIN="$(node -p 'require(process.argv[1]).pin' "$PKGS/candidate.json")"
SYS_NODE="$(command -v node)"; SYS_NODE_VERSION="$(node --version)"
WORK="${RUNNER_TEMP:?}/gui"; PREFIX="$WORK/prefix"
mkdir -p "$WORK" "$PREFIX"
# shellcheck source=checks.sh
. "$HERE/checks.sh"
UID_="$(id -u)"; DOMAIN="gui/$UID_"; LABEL=com.agend.fleet; TARGET="$DOMAIN/$LABEL"
PORT=19391
export npm_config_prefix="$PREFIX" npm_config_cache="$WORK/cache"
export PATH="$PREFIX/bin:$PATH"

step "the GUI domain exists on this runner"
launchctl print "$DOMAIN" >/dev/null 2>&1 || fail "launchctl print $DOMAIN failed: no GUI domain on this runner — not substituting another"
echo "  $DOMAIN: present"

job_pid() { launchctl print "$TARGET" 2>/dev/null | sed -n 's/^[[:space:]]*pid = //p' | head -1; }
job_field() { launchctl print "$TARGET" 2>/dev/null | sed -n "s/^[[:space:]]*$1 = //p" | head -1; }
health() { curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/health" || true; }
wait_health() { for _ in $(seq 90); do [ "$(health)" = 200 ] && return 0; sleep 1; done; return 1; }
show_job() { launchctl print "$TARGET" | grep -E '^[[:space:]]+(state|pid|program) =|^[[:space:]]+arguments = \{' -A4 | head -12 | sed 's/^/    /'; }

step "2.1.12 on Node $SYS_NODE_VERSION (npmjs), a fleet with no channels, \`agend install\` into $DOMAIN"
npm install -g --no-audit --no-fund --registry https://registry.npmjs.org/ @songsid/agend@2.1.12 >/dev/null
[ "$(agend --version)" = 2.1.12 ] || fail "agend 2.1.12 did not install"
mkdir -p "$HOME/.agend"
printf 'health_port: %s\ninstances: {}\n' "$PORT" > "$HOME/.agend/fleet.yaml"
agend install
wait_health || { show_job || true; fail "the 2.1.12 service did not answer /health"; }
OLD_PID="$(job_pid)"
echo "  loaded and running: pid $OLD_PID, program $(job_field program)"

step "2.1.12's own \`agend update --version $CAND\` (candidate from the local registry)"
set +e
npm_config_userconfig="$RUNNER_TEMP/registry/npmrc" agend update --version "$CAND" --yes 2>&1 | tee "$WORK/update.out"
rc=${PIPESTATUS[0]}
set -e
echo "  the old updater exited $rc"
# The hop's verdict, before anything else touches the service: the old updater must have installed the candidate,
# succeeded, and ACTIVATED it — its restart consumed the planned activation. Nothing here repairs a failed hop.
grep -q "Installed: $CAND" "$WORK/update.out" || fail "the old updater did not install $CAND"
[ "$rc" = 0 ] || fail "the old updater exited $rc: it installed $CAND but did not complete the update"
[ ! -f "$HOME/.agend/service-plan.json" ] || fail "the old updater left the planned activation unconsumed: launchd was not switched to $CAND"
echo "  hop verdict: the old updater installed $CAND, exited 0 and consumed the planned activation"

check_installed

step "after the update: what launchd runs"
wait_health || { show_job || true; fail "the fleet did not answer /health after the update"; }
show_job
NEW_PID="$(job_pid)"
[ -n "$NEW_PID" ] && [ "$NEW_PID" != "$OLD_PID" ] || fail "launchd's job pid is '$NEW_PID' (before: $OLD_PID): the new install was not activated"
[ "$(job_field program)" = "$RT_NODE" ] || fail "launchd's program is $(job_field program), not the bundled $RT_NODE"
ARGV0="$(ps -o comm= -p "$NEW_PID")"
[ "$(realpath_of "$ARGV0")" = "$RT_NODE" ] || fail "the fleet process runs $ARGV0, not the bundled $RT_NODE"
echo "  pid $NEW_PID runs $ARGV0; /health $(health)"
FLEET_PATH="$(ps eww -o command= -p "$NEW_PID" | tr ' ' '\n' | sed -n 's/^PATH=//p' | head -1)"
[ -n "$FLEET_PATH" ] || fail "the fleet's PATH could not be read"
check_cli_node "the launchd fleet's environment" "$FLEET_PATH" "$(realpath_of "$SYS_NODE")"

step "the restart guard on the loaded GUI job"
agend restart --yes
wait_health || fail "the fleet did not come back after an admitted restart"
P2="$(job_pid)"; [ "$(realpath_of "$(ps -o comm= -p "$P2")")" = "$RT_NODE" ] || fail "after restart the fleet is not on the bundled Node"
echo "  admitted: restarted, pid $P2 on the bundled Node"
launchctl setenv AGEND_NODE /usr/bin/false
set +e; agend restart --yes > "$WORK/refused.out" 2>&1; rrc=$?; set -e
launchctl unsetenv AGEND_NODE
cat "$WORK/refused.out"
[ "$rrc" != 0 ] || fail "agend restart was not refused with AGEND_NODE in launchd's environment"
grep -q "AGEND_NODE" "$WORK/refused.out" || fail "the refusal does not name AGEND_NODE"
[ "$(job_pid)" = "$P2" ] || fail "a refused restart touched the fleet (pid $(job_pid), was $P2)"
echo "  refused (exit $rrc) and nothing was stopped (pid $P2)"

step "clean up"
launchctl bootout "$TARGET" || true
for _ in $(seq 30); do launchctl print "$TARGET" >/dev/null 2>&1 || break; sleep 1; done
launchctl print "$TARGET" >/dev/null 2>&1 && fail "the job is still loaded after bootout"
echo "  booted out; GUI-domain rehearsal passed"
