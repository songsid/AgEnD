#!/usr/bin/env bash
# M-3770 slices 1.2 and 1.3: the pre-flight on real installs. This checkout is built, packed and installed into two npm
# prefixes (A, B) and npm-linked into a third (C); each scenario is run by the installed copy itself with real npm, real
# files, real processes and a real registry, on a scratch AgEnD home it stands in the fleet for (run.mjs writes that
# home's fleet.lock). No fleet is started and no service is touched: P3 reads the caller's own cgroup and a read-only
# `systemctl show` (run from inside a fleet's unit, P3 is that unit's real state); P2 reads this user's live processes,
# services and global installs, so a fleet already running on this computer shows up as another install (S1–S8).
# Stand-ins for "another fleet" and "another update" are harmless processes (a sleeping script named like a fleet, a
# holder of the home lock), killed by their own pid at the end.
# Usage: scripts/manual/update-preflight-m3770/rig.sh <empty scratch dir>
set -euo pipefail
REPO=$(cd "$(dirname "$0")/../../.." && pwd); R=${1:?scratch dir}; mkdir -p "$R"; R=$(cd "$R" && pwd -P)
HERE=$(cd "$(dirname "$0")" && pwd)
(cd "$REPO" && npx tsc -p . >/dev/null 2>&1 || true; npm pack --ignore-scripts --pack-destination "$R" >/dev/null)
for P in A B; do (cd "$R" && npm i -g --prefix "$R/$P" --ignore-scripts --no-audit --no-fund ./songsid-agend-*.tgz >/dev/null); done
npm i -g --prefix "$R/C" --ignore-scripts --no-audit --no-fund "$REPO" >/dev/null                  # a folder install = npm link
T=$(npm view @songsid/agend version); A=$R/A; B=$R/B; C=$R/C; H=$R/home
PA=$A/lib/node_modules/@songsid/agend; PB=$B/lib/node_modules/@songsid/agend
SYS=$(dirname "$(command -v node)"):/usr/bin:/bin
# The fleet's own environment reaches its user manager: the session bus goes through (P3 asks systemd about the unit).
BUS=(); [ -n "${XDG_RUNTIME_DIR:-}" ] && BUS+=(XDG_RUNTIME_DIR="$XDG_RUNTIME_DIR"); [ -n "${DBUS_SESSION_BUS_ADDRESS:-}" ] && BUS+=(DBUS_SESSION_BUS_ADDRESS="$DBUS_SESSION_BUS_ADDRESS")
run() { local name=$1 pkg=$2; shift 2; echo "== $name"; env -i HOME="$HOME" USER="$USER" "${BUS[@]}" "$@" timeout 300 node "$HERE/run.mjs" "$pkg" "$T" "$H" | tail -1; }
pids=(); cleanup() { for p in "${pids[@]}"; do kill "$p" 2>/dev/null || true; done; }; trap cleanup EXIT

run "S1 one install (A); npm manages A; PATH A first" "$PA" PATH="$A/bin:$SYS" npm_config_prefix="$A"
run "S2 two installs: running A, PATH's agend is B's" "$PA" PATH="$B/bin:$A/bin:$SYS" npm_config_prefix="$A"
run "S3 two installs: running B, npm manages A" "$PB" PATH="$A/bin:$SYS" npm_config_prefix="$A"
chmod a-w "$A/bin"; run "S4 A's bin not writable" "$PA" PATH="$A/bin:$SYS" npm_config_prefix="$A"; chmod u+w "$A/bin"
run "S5 a source checkout" "$REPO" PATH="$A/bin:$SYS" npm_config_prefix="$A"
run "S6 npm link: C's entry links to the running checkout" "$REPO" PATH="$C/bin:$SYS" npm_config_prefix="$C"
echo "== S7 the service can't be asked (no session bus reaches systemd)"
env -i HOME="$HOME" USER="$USER" PATH="$A/bin:$SYS" npm_config_prefix="$A" timeout 300 node "$HERE/run.mjs" "$PA" "$T" "$H" | tail -1
run "S8 the registry unreachable" "$PA" PATH="$A/bin:$SYS" npm_config_prefix="$A" npm_config_registry=https://registry.invalid.example/

# S9: another install's fleet on this home. A harmless stand-in: a sleeping script at <F>/…/@songsid/agend/dist/cli.js,
# run as `node …/cli.js fleet start` with AGEND_HOME on this home — the process shape P2 looks for. Never a fleet.
F=$R/F/lib/node_modules/@songsid/agend; mkdir -p "$F/dist"
echo '{"name":"@songsid/agend","version":"0.0.0-standin"}' > "$F/package.json"; echo 'setInterval(() => {}, 1 << 30);' > "$F/dist/cli.js"
AGEND_HOME="$H" node "$F/dist/cli.js" fleet start >/dev/null 2>&1 & pids+=($!); sleep 1
run "S9 another install's fleet (stand-in) runs on this home" "$PA" PATH="$A/bin:$SYS" npm_config_prefix="$A"
kill "${pids[-1]}"; wait "${pids[-1]}" 2>/dev/null || true

run "S10 a rehearsal marker in the fleet's environment" "$PA" PATH="$A/bin:$SYS" npm_config_prefix="$A" AGEND_REHEARSAL=1

# S11: another install's update holds this home's update lock (a real process, as `agend update` from B would).
node "$HERE/lock.mjs" hold "$PB" "$H" "$(cd "$B" && pwd -P)" > "$R/holder.out" & pids+=($!); sleep 1
echo "== S11 holder: $(cat "$R/holder.out")"
run "S11 another install's update holds this home's lock" "$PA" PATH="$A/bin:$SYS" npm_config_prefix="$A"
echo "== S11 a fleet start of A (another install) on this home:"; node "$HERE/lock.mjs" start "$PA" "$H" "$(cd "$A" && pwd -P)"
echo "== S11 a fleet start of B (the updating install's own restart):"; node "$HERE/lock.mjs" start "$PB" "$H" "$(cd "$B" && pwd -P)"
