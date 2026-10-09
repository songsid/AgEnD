#!/usr/bin/env bash
# #1450 runtime acceptance, the 2.1.12 → 2.2 hop on Node 20 (docs/design/1450-private-node-runtime.md):
#   leg 1: the REAL published 2.1.12 runs `agend update --version <candidate>` (its writable-prefix branch: unlink,
#          npm install -g, verify, install --no-activate, completion refresh, restart) against the local registry;
#   leg 2: a plain `npm install -g @songsid/agend@<candidate>` over 2.1.12.
# After each: the candidate is installed and runs on its bundled Node (check_installed). Service managers are behind
# a guard: systemctl, launchctl and sudo are stubs that log and fail, so no step can reach a real service manager.
# Usage: hop.sh <packages dir>   (after registry.sh; system Node 20.19 on PATH)
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
PKGS="${1:?packages dir}"
CAND="$(node -p 'require(process.argv[1]).version' "$PKGS/candidate.json")"
PIN="$(node -p 'require(process.argv[1]).pin' "$PKGS/candidate.json")"
SYS_NODE="$(command -v node)"; SYS_NODE_VERSION="$(node --version)"
OLD=2.1.12
# shellcheck source=checks.sh
. "$HERE/checks.sh"
case "$SYS_NODE_VERSION" in v20.*) ;; *) fail "the hop runs on Node 20 (got $SYS_NODE_VERSION)" ;; esac

# A fresh, isolated world for one leg: prefix, HOME, AGEND_HOME, npm cache/config, guarded service managers.
fresh() {
  WORK="${RUNNER_TEMP:?}/hop-$1"
  rm -rf "$WORK"; mkdir -p "$WORK"/{prefix,home,cache,agend-home,guard}
  PREFIX="$WORK/prefix"
  export HOME="$WORK/home" XDG_CONFIG_HOME="$WORK/home/.config" AGEND_HOME="$WORK/agend-home"
  export npm_config_userconfig="$RUNNER_TEMP/registry/npmrc" npm_config_cache="$WORK/cache" npm_config_prefix="$PREFIX"
  for tool in systemctl launchctl sudo; do
    printf '#!/bin/sh\necho "%s $*" >> "%s/guard.log"\nexit 1\n' "$tool" "$WORK" > "$WORK/guard/$tool"
    chmod +x "$WORK/guard/$tool"
  done
  export PATH="$WORK/guard:$PREFIX/bin:$ORIG_PATH"
  step "[$1] npm install -g @songsid/agend@$OLD (npmjs) on Node $SYS_NODE_VERSION, npm $(npm --version)"
  npm install -g --no-audit --no-fund --registry https://registry.npmjs.org/ "@songsid/agend@$OLD"
  [ "$(agend --version)" = "$OLD" ] || fail "agend $OLD did not install"
  [ "$(command -v agend)" = "$PREFIX/bin/agend" ] || fail "agend resolves to $(command -v agend)"
}
ORIG_PATH="$PATH"

fresh old-updater
step "[old-updater] agend $OLD: agend update --version $CAND --yes"
set +e
agend update --version "$CAND" --yes 2>&1 | tee "$WORK/update.out"
rc=${PIPESTATUS[0]}
set -e
echo "  the old updater exited $rc (its final restart has no fleet or service to restart here)"
echo "  guarded calls:"; sed 's/^/    /' "$WORK/guard.log" 2>/dev/null || echo "    none"
check_installed

fresh npm-install
step "[npm-install] npm install -g @songsid/agend@$CAND over $OLD"
npm install -g --no-audit --no-fund "@songsid/agend@$CAND"
check_installed
