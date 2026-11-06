#!/usr/bin/env bash
# #1450 runtime acceptance, the previous-release → candidate hop on an old system Node — 20, 18 or 16 (docs/design/1450-private-node-runtime.md):
#   leg 1: the REAL published 2.3.3 runs `agend update --version <candidate>` (its writable-prefix branch: unlink,
#          npm install -g, verify, install --no-activate, completion refresh, restart) against the local registry;
#   leg 2: a plain `npm install -g @songsid/agend@<candidate>` over 2.3.3.
# The previous release ships its own runtime, so both legs run on every old host-Node cell.
# After each: the candidate is installed and runs on its bundled Node (check_installed). A fail-fast boundary:
#   - systemctl, launchctl and sudo are stubs that log and fail, so nothing reaches a real service manager by name;
#   - every Node process preloads boundary.cjs: a fleet start in any form (node entry, `agend`, the launcher, a shell
#     string, the process itself) or a service manager by absolute path fails at once and is logged;
# and each leg GATES on it: an empty boundary log, no stub call that would activate anything, and the updater's
# expected exit.
# Usage: hop.sh <packages dir>   (after registry.sh; system Node 16, 18 or 20 on PATH)
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
PKGS="${1:?packages dir}"
CAND="$(node -p 'require(process.argv[1]).version' "$PKGS/candidate.json")"
PIN="$(node -p 'require(process.argv[1]).pin' "$PKGS/candidate.json")"
SYS_NODE="$(command -v node)"; SYS_NODE_VERSION="$(node --version)"
OLD=2.3.3
# #1819: the published $OLD, from its cached tarball that .github/actions/published-agend-tarball checked against the
# registry's dist.integrity: installing it downloads no @songsid/agend tarball from npmjs (that would count as a download).
OLD_TGZ="${AGEND_OLD_TARBALL:?the published 2.3.3 tarball (.github/actions/published-agend-tarball)}"
# shellcheck source=checks.sh
. "$HERE/checks.sh"
case "$SYS_NODE_VERSION" in v16.*|v18.*|v20.*) ;; *) fail "the hop runs on an old Node: 16, 18 or 20 (got $SYS_NODE_VERSION)" ;; esac

# A fresh, isolated world for one leg: prefix, HOME, AGEND_HOME, npm cache/config, guarded service managers.
fresh() {
  WORK="${RUNNER_TEMP:?}/hop-$1"
  rm -rf "$WORK"; mkdir -p "$WORK"/{prefix,home,cache,agend-home,guard}
  PREFIX="$WORK/prefix"
  export HOME="$WORK/home" XDG_CONFIG_HOME="$WORK/home/.config" AGEND_HOME="$WORK/agend-home"
  export npm_config_userconfig="$RUNNER_TEMP/registry/npmrc" npm_config_cache="$WORK/cache" npm_config_prefix="$PREFIX"
  # Each call is logged as `<name>( <len>:<bytes>)*` — argv boundaries kept (manager-activations.cjs) — and fails.
  for tool in systemctl launchctl sudo; do
    cat > "$WORK/guard/$tool" <<STUB
#!/bin/sh
LC_ALL=C; export LC_ALL
{ printf '%s' "$tool"; for a in "\$@"; do printf ' %d:%s' "\${#a}" "\$a"; done; printf '\\n'; } >> "$WORK/guard.log"
exit 1
STUB
    chmod +x "$WORK/guard/$tool"
  done
  : > "$WORK/guard.log"
  export PATH="$WORK/guard:$PREFIX/bin:$ORIG_PATH"
  export AGEND_BOUNDARY_LOG="$WORK/boundary.log"
  # A bare systemctl/launchctl must resolve to these stubs on the effective PATH of whatever runs it.
  export AGEND_BOUNDARY_STUBS="$WORK/guard"
  : > "$AGEND_BOUNDARY_LOG"
  export NODE_OPTIONS="--require=$HERE/boundary.cjs"
  step "[$1] npm install -g @songsid/agend@$OLD (its published tarball; dependencies from npmjs) on Node $SYS_NODE_VERSION, npm $(npm --version)"
  bash "$HERE/../install-published-tarball.sh" @songsid/agend "$OLD_TGZ" --registry https://registry.npmjs.org/
  [ -f "$PREFIX/lib/node_modules/@songsid/agend/package.json" ] && [ "$(node -p 'require(process.argv[1]).version' "$PREFIX/lib/node_modules/@songsid/agend/package.json")" = "$OLD" ] || fail "agend $OLD did not install"
  [ "$(agend --version)" = "$OLD" ] || fail "agend $OLD does not start on its bundled runtime"
  [ "$(command -v agend)" = "$PREFIX/bin/agend" ] || fail "agend resolves to $(command -v agend)"
}
ORIG_PATH="$PATH"

# The boundary held: nothing tried to start a fleet or reach a service manager by path, and no stubbed manager call was
# one that activates anything (reads and a refused daemon-reload are what a refresh/restart may attempt).
check_boundary() {
  step "[$1] the process boundary held"
  if [ -s "$AGEND_BOUNDARY_LOG" ]; then cat "$AGEND_BOUNDARY_LOG"; fail "a fleet start or a service manager by path was attempted"; fi
  echo "  stubbed manager calls:"; sed 's/^/    /' "$WORK/guard.log"; [ -s "$WORK/guard.log" ] || echo "    none"
  # Fails closed (manager-activations.cjs): any sudo, an option it cannot judge, or a verb that is not read-only.
  if ! node "$HERE/manager-activations.cjs" "$WORK/guard.log"; then
    fail "a stubbed service-manager call was not plainly read-only"
  fi
}

fresh old-updater
step "[old-updater] agend $OLD: agend update --version $CAND --yes"
set +e
agend update --version "$CAND" --yes 2>&1 | tee "$WORK/update.out"
rc=${PIPESTATUS[0]}
set -e
# Expected: the install and its verification succeed, then the final restart has no fleet and no reachable service
# manager (stubs) to restart, so the old updater reports a failed restart: exit 1 — nothing else.
check_installed # installed identity/runtime/receipt/SQLite, not a historical output string
[ "$rc" = 1 ] || fail "the old updater exited $rc; expected 1 (installed, then a restart with nothing to restart)"
echo "  the old updater exited 1 after installing $CAND, as expected (no fleet or service to restart)"
check_boundary old-updater
fresh npm-install
step "[npm-install] npm install -g @songsid/agend@$CAND over $OLD"
npm install -g --no-audit --no-fund "@songsid/agend@$CAND"
check_boundary npm-install
check_installed
