#!/usr/bin/env bash
# M-3770 slice 1.2: the pre-flight on real installs — this checkout built, packed and installed into two npm prefixes
# (A, B) and npm-linked into a third (C), then each scenario run by the installed copy itself with real npm, real
# files and a real registry. No fleet is started and no service is touched (P3 reads the caller's own cgroup and
# `systemctl show`). Usage: scripts/manual/update-preflight-m3770/rig.sh <empty scratch dir>
set -euo pipefail
REPO=$(cd "$(dirname "$0")/../../.." && pwd); R=${1:?scratch dir}; mkdir -p "$R"
HERE=$(cd "$(dirname "$0")" && pwd)
(cd "$REPO" && npx tsc -p . >/dev/null 2>&1 || true; npm pack --ignore-scripts --pack-destination "$R" >/dev/null)
for P in A B; do (cd "$R" && npm i -g --prefix "$R/$P" --ignore-scripts --no-audit --no-fund ./songsid-agend-*.tgz >/dev/null); done
npm i -g --prefix "$R/C" --ignore-scripts --no-audit --no-fund "$REPO" >/dev/null                  # a folder install = npm link
T=$(npm view @songsid/agend version); A=$R/A; B=$R/B; C=$R/C
PA=$A/lib/node_modules/@songsid/agend; PB=$B/lib/node_modules/@songsid/agend
SYS=$(dirname "$(command -v node)"):/usr/bin:/bin
run() { local name=$1 pkg=$2; shift 2; echo "== $name"; env -i HOME="$HOME" USER="$USER" "$@" timeout 300 node "$HERE/run.mjs" "$pkg" "$T" | tail -1; }
run "S1 one install (A); npm manages A; PATH A first" "$PA" PATH="$A/bin:$SYS" npm_config_prefix="$A"
run "S2 two installs: running A, PATH's agend is B's" "$PA" PATH="$B/bin:$A/bin:$SYS" npm_config_prefix="$A"
run "S3 two installs: running B, npm manages A" "$PB" PATH="$A/bin:$SYS" npm_config_prefix="$A"
chmod a-w "$A/bin"; run "S4 A's bin not writable" "$PA" PATH="$A/bin:$SYS" npm_config_prefix="$A"; chmod u+w "$A/bin"
run "S5 a source checkout" "$REPO" PATH="$A/bin:$SYS" npm_config_prefix="$A"
run "S6 npm link: C's entry links to the running checkout" "$REPO" PATH="$C/bin:$SYS" npm_config_prefix="$C"
run "S8 the registry unreachable" "$PA" PATH="$A/bin:$SYS" npm_config_prefix="$A" npm_config_registry=https://registry.invalid.example/
