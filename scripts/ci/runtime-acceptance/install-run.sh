#!/usr/bin/env bash
# #1450 runtime acceptance, install-and-run: on this runner's system Node (16, 18, 20.19 or 22), a plain
# `npm install -g @songsid/agend@<candidate>` from the local registry must install and verify the bundled Node, and
# AgEnD — CLI, database, daemon — must run on it, never on the system Node, even when the system Node qualifies.
# Usage: install-run.sh <packages dir> [service]   (after registry.sh; everything lives under $RUNNER_TEMP/accept)
#   service: on the install the first run left, check what `agend install --no-activate` writes (a separate step:
#   it needs #1450 PR 3, and until then fails on its own without hiding the rest).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
PKGS="${1:?packages dir}"; MODE="${2:-run}"
WORK="${RUNNER_TEMP:?}/accept"
[ "$MODE" = service ] || { rm -rf "$WORK"; mkdir -p "$WORK"/{prefix,home,cache,agend-home}; }
CAND="$(node -p 'require(process.argv[1]).version' "$PKGS/candidate.json")"
PIN="$(node -p 'require(process.argv[1]).pin' "$PKGS/candidate.json")"
SYS_NODE="$(command -v node)"; SYS_NODE_VERSION="$(node --version)"
PREFIX="$WORK/prefix"
export HOME="$WORK/home" XDG_CONFIG_HOME="$WORK/home/.config" AGEND_HOME="$WORK/agend-home"
export npm_config_userconfig="$RUNNER_TEMP/registry/npmrc" npm_config_cache="$WORK/cache" npm_config_prefix="$PREFIX"
# shellcheck source=checks.sh
. "$HERE/checks.sh"

if [ "$MODE" = service ]; then
  RT_NODE="$(node -pe 'JSON.parse(process.argv[1]).node' "$("$PREFIX/bin/agend" --agend-select-json)")"
  check_service_files
  exit 0
fi

step "npm install -g @songsid/agend@$CAND on Node $SYS_NODE_VERSION, npm $(npm --version)"
npm install -g --no-audit --no-fund "@songsid/agend@$CAND"

# M-2457: AgEnD runs only its bundled tmux (no PATH fallback): the pinned package is installed and its postinstall
# check passed (the receipt names that pin and a binary of the declared size).
step "the bundled tmux is installed and verified"
node -e '
  const fs = require("fs"), path = require("path");
  const pkg = path.join(process.argv[1], "lib/node_modules/@songsid/agend");
  const m = JSON.parse(fs.readFileSync(path.join(pkg, "package.json"), "utf8"));
  const name = `@songsid/agend-tmux-${process.platform}-${process.arch}`, pin = (m.optionalDependencies || {})[name];
  if (!pin) { console.error(`no ${name} pin in the candidate`); process.exit(1); }
  const r = JSON.parse(fs.readFileSync(path.join(pkg, ".agend-tmux.json"), "utf8"));
  if (r.pinnedVersion !== pin || fs.statSync(r.tmuxPath).size !== r.size) { console.error("the receipt does not match the pin"); process.exit(1); }
  console.log(`  ${name}@${pin}: tmux ${r.tmux}, sha256 ${r.sha256.slice(0, 16)}…, verified ${r.verifiedAt}`);
' "$PREFIX"

check_installed
check_daemon
check_no_system_node
