#!/usr/bin/env bash
# Ephemeral CI only: published previous release -> candidate -> previous release.
set -euo pipefail
BASELINE_TGZ="${1:?verified previous-release tarball}"
CANDIDATE_TGZ="${2:?candidate tarball}"
BASELINE_VERSION="${3:?previous-release version}"
[[ "$BASELINE_VERSION" =~ ^2\.3\.[0-9]+$ ]] || { echo 'Expected a stable current-line rollback target' >&2; exit 1; }
WORK=$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/agend-release-rollback.XXXXXX")
trap 'rm -rf "${WORK:?}"' EXIT
PREFIX="$WORK/prefix"
export AGEND_HOME="$WORK/agend"
export npm_config_cache="$WORK/cache" npm_config_userconfig="$WORK/npmrc"
: > "$npm_config_userconfig"
CANDIDATE_VERSION=$(tar -xOf "$CANDIDATE_TGZ" package/package.json | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).version')
verify() {
  local want="$1" pkg="$PREFIX/lib/node_modules/@songsid/agend"
  [ "$(node -p 'require(process.argv[1]).version' "$pkg/package.json")" = "$want" ]
  [ "$("$PREFIX/bin/agend" --version)" = "$want" ]
  echo "Verified installed manifest and CLI: $want"
}
bash scripts/ci/install-published-tarball.sh @songsid/agend "$BASELINE_TGZ" --prefix "$PREFIX"
verify "$BASELINE_VERSION"
npm install --global --prefix "$PREFIX" "$CANDIDATE_TGZ" --registry https://registry.npmjs.org/
verify "$CANDIDATE_VERSION"
bash scripts/ci/install-published-tarball.sh @songsid/agend "$BASELINE_TGZ" --prefix "$PREFIX"
verify "$BASELINE_VERSION"
echo "Previous-release rollback confirmed: $BASELINE_VERSION -> $CANDIDATE_VERSION -> $BASELINE_VERSION"
